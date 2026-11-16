import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";
import {
  ambienteAssinatura, carregar, catalogoNativo, cenario, congelarEAssinarKidmais, cpfValido, dia, executor, id, poolNaTransacao,
  type Cenario,
} from "../../scripts/integracao-importados-test-support.ts";
import { travarConfiguracaoAgenda } from "../agenda/trava-configuracao.ts";
import type { DbExecutor } from "../db/contracts.ts";

/**
 * Reserva por e-mail do código OTP (12/11/2026, LOCAL) no PostgreSQL DESCARTÁVEL, modelo 112 (sem migration nova: CANCELADA
 * e EMAIL existem desde a 008). Prova contra as CHECKs reais o que os testes com mock não exercitam:
 *  1. reserva automática: WhatsApp falha no envio → desafio dele CANCELADO, o do e-mail PENDENTE com os envios certos, e o
 *     código do e-mail confirma;
 *  2. botão: o desafio do e-mail herda tentativas e envios (P1); 4 erros no WhatsApp deixam 1 tentativa no e-mail;
 *  3. envios esgotados: LIMITE_ENVIOS_OTP sem efeito no banco;
 *  4. falha do e-mail: o WhatsApp é REABERTO (pendente_check vale) e o código atrasado confirma (P2);
 *  5. reabrirValidacaoCancelada recusa expirado, confirmado e o que não está CANCELADA;
 *  6. corrida REAL entre duas conexões: dois cliques no botão → um vence, o outro VALIDACAO_NAO_PENDENTE;
 *  7. corrida REAL: clique durante a reabertura (e-mail falhou na outra conexão) → o segundo clique espera e segue sobre o
 *     desafio reaberto; no fim há um só desafio PENDENTE;
 *  8. contrato com a trava desligada: EMAIL → CANAL_INDISPONIVEL 400 (P3), WhatsApp segue.
 * Nenhum envio real: o emissor é injetado. Os testes 1–5 e 8 terminam em ROLLBACK; 6–7 gravam (precisam de duas conexões)
 * no banco de trabalho, que o check:v1:postgres recria a cada suíte.
 */
const opt = () => process.env.KIDMAIS_POSTGRES_DESCARTAVEL === "kidmais_pacotes_v1_descartavel";
let a: Client;

type Servicos = typeof import("./services/index.ts");
type Envio = { canal: string; codigo: string; validacaoId: string };
const servicos = () => carregar<Servicos>("lib/identidade/services/index.ts");
const PEPPER = "pepper-sintetico-reserva-email-0123456789";

/** Serviço com reserva ligada, espera de 1 ms e emissor sintético; `falhar` decide por canal se o "provedor" falha. */
function servico(enviados: Envio[], falhar: (canal: string) => boolean) {
  return servicos().criarIdentityService({
    otpPepper: PEPPER,
    reservaEmail: true,
    // A configuração exige espera > 0; 1 ms já passou quando o teste clica (o envio foi gravado antes).
    reservaEmailEsperaMs: 1,
    enviarOtp: async (d) => {
      if (falhar(d.canal)) throw new Error(`provedor sintético ${d.canal} fora`);
      enviados.push({ canal: d.canal, codigo: d.codigo, validacaoId: d.validacaoId });
    },
  });
}
const nunca = () => false;
const codigoErrado = (certo: string) => (certo === "000000" ? "111111" : "000000");

async function emTx(corpo: () => Promise<void>) {
  await a.query("BEGIN");
  const restaurarPool = poolNaTransacao(a);
  const restaurarAmbiente = ambienteAssinatura();
  try { await corpo(); } finally { await a.query("ROLLBACK"); restaurarAmbiente(); restaurarPool(); }
}
async function recusa<T>(p: () => Promise<T>, codigo: string, status?: number) {
  await a.query("SAVEPOINT recusa");
  await assert.rejects(p(), (e: unknown) => {
    const x = e as { code?: string; httpStatus?: number };
    assert.equal(x.code, codigo);
    if (status !== undefined) assert.equal(x.httpStatus, status);
    return true;
  });
  await a.query("ROLLBACK TO SAVEPOINT recusa");
}

const endereco = `'01001000', 'Rua Sintética', '1', 'Centro', 'São Paulo', 'SP'`;
/** Cliente PF sintético: e-mail em domínio reservado (.invalid), telefone fictício. */
async function clientePf(db: Client, c: Cenario, opcoes: { whatsapp?: boolean } = {}) {
  const cpf = cpfValido();
  const whatsapp = opcoes.whatsapp === false ? null : "11999998888";
  await id(db,
    `INSERT INTO clientes (nome_completo, cpf, empresa_id, email, telefone, whatsapp, cep, logradouro, numero, bairro, cidade, uf)
     VALUES ('Cliente Sintético', $1, $2::uuid, $3, '11999998888', $4, ${endereco}) RETURNING id`,
    [cpf, c.empresa, `${randomUUID()}@example.invalid`, whatsapp]);
  return cpf;
}
const escopo = (c: Cenario) => ({ empresaId: c.empresa, incluirLegadoSemEmpresa: false });
type Linha = { id: string; canal: string; status: string; tentativas: number; envios: number; max_tentativas: number; max_envios: number };
async function linhas(db: Client, cpf: string) {
  return (await db.query<Linha>(
    `SELECT v.id::text AS id, v.canal, v.status, v.tentativas, v.envios, v.max_tentativas, v.max_envios
       FROM validacoes_identidade_cliente v JOIN clientes c ON c.id = v.cliente_id
      WHERE c.cpf = $1 ORDER BY v.criado_em, v.canal DESC`, [cpf])).rows;
}

test.before(async () => {
  if (!opt()) return;
  process.env.FESTA_ENABLED = "true";
  a = await conectarDescartavel();
});
test.after(async () => { if (a) await encerrarDescartavel(a); });

test("1. reserva automática: WhatsApp falha no envio → CANCELADA; e-mail PENDENTE (envios 1) e o código dele confirma", { skip: !opt(), timeout: 300_000 }, async () => {
  await emTx(async () => {
    const c = await cenario(a, 0);
    const cpf = await clientePf(a, c);
    const enviados: Envio[] = [];
    const s = servico(enviados, (canal) => canal === "WHATSAPP");
    const db = executor(a);
    const d = await s.iniciarDesafio({ cpf, canal: "WHATSAPP", escopo: escopo(c) }, db);
    assert.equal(d.canal, "EMAIL");
    assert.equal(d.reserva, "FALHA_WHATSAPP");
    assert.deepEqual((await linhas(a, cpf)).map((l) => [l.canal, l.status, l.tentativas, l.envios]),
      [["WHATSAPP", "CANCELADA", 0, 0], ["EMAIL", "PENDENTE", 0, 1]]);
    assert.deepEqual(enviados.map((e) => e.canal), ["EMAIL"]);
    const prova = await s.confirmarCodigo({ validacaoId: d.validacaoId, codigo: enviados[0].codigo }, db);
    assert.ok(prova.provaToken);
    assert.equal((await linhas(a, cpf))[1].status, "CONFIRMADA");
  });
});

test("2. botão: e-mail herda tentativas e envios (P1); 4 erros no WhatsApp deixam 1 tentativa e o erro seguinte bloqueia", { skip: !opt(), timeout: 300_000 }, async () => {
  await emTx(async () => {
    const c = await cenario(a, 0);
    const cpf = await clientePf(a, c);
    const enviados: Envio[] = [];
    const s = servico(enviados, nunca);
    const db = executor(a);
    const d = await s.iniciarDesafio({ cpf, canal: "WHATSAPP", escopo: escopo(c) }, db);
    assert.equal(d.canal, "WHATSAPP");
    // Erro de código não aborta a transação: as 4 tentativas ficam gravadas como no fluxo real.
    for (let i = 0; i < 4; i++) {
      await assert.rejects(s.confirmarCodigo({ validacaoId: d.validacaoId, codigo: codigoErrado(enviados[0].codigo) }, db),
        (x: unknown) => (x as { code?: string }).code === "CODIGO_INVALIDO");
    }
    const e = await s.receberCodigoPorEmail(d.validacaoId, db);
    assert.equal(e.canal, "EMAIL");
    assert.deepEqual((await linhas(a, cpf)).map((l) => [l.canal, l.status, l.tentativas, l.envios, l.max_tentativas, l.max_envios]),
      [["WHATSAPP", "CANCELADA", 4, 1, 5, 3], ["EMAIL", "PENDENTE", 4, 2, 5, 3]]);
    // O código antigo (WhatsApp) não vale mais.
    await recusa(() => s.confirmarCodigo({ validacaoId: d.validacaoId, codigo: enviados[0].codigo }, db), "VALIDACAO_NAO_PENDENTE");
    // Um erro no e-mail atinge o máximo herdado: BLOQUEADA (tentativas_check: 5 <= 5).
    await a.query("SAVEPOINT bloqueio");
    await assert.rejects(s.confirmarCodigo({ validacaoId: e.validacaoId, codigo: codigoErrado(enviados[1].codigo) }, db),
      (x: unknown) => (x as { code?: string }).code === "CODIGO_BLOQUEADO");
    assert.deepEqual((await linhas(a, cpf)).map((l) => [l.canal, l.status, l.tentativas]), [["WHATSAPP", "CANCELADA", 4], ["EMAIL", "BLOQUEADA", 5]]);
    await a.query("ROLLBACK TO SAVEPOINT bloqueio");
    // Sem errar: o código do e-mail confirma.
    assert.ok((await s.confirmarCodigo({ validacaoId: e.validacaoId, codigo: enviados[1].codigo }, db)).provaToken);
  });
});

test("3. envios esgotados: LIMITE_ENVIOS_OTP 429 sem cancelar nem enviar", { skip: !opt(), timeout: 300_000 }, async () => {
  await emTx(async () => {
    const c = await cenario(a, 0);
    const cpf = await clientePf(a, c);
    const enviados: Envio[] = [];
    const s = servico(enviados, nunca);
    const db = executor(a);
    const d = await s.iniciarDesafio({ cpf, canal: "WHATSAPP", escopo: escopo(c) }, db);
    await a.query("UPDATE validacoes_identidade_cliente SET envios = max_envios WHERE id = $1::uuid", [d.validacaoId]);
    await recusa(() => s.receberCodigoPorEmail(d.validacaoId, db), "LIMITE_ENVIOS_OTP", 429);
    assert.deepEqual((await linhas(a, cpf)).map((l) => [l.canal, l.status, l.envios]), [["WHATSAPP", "PENDENTE", 3]]);
    assert.equal(enviados.length, 1);
  });
});

test("4. falha do e-mail no botão: WhatsApp REABERTO (pendente_check) e o código atrasado confirma (P2)", { skip: !opt(), timeout: 300_000 }, async () => {
  await emTx(async () => {
    const c = await cenario(a, 0);
    const cpf = await clientePf(a, c);
    const enviados: Envio[] = [];
    let emailFora = true;
    const s = servico(enviados, (canal) => canal === "EMAIL" && emailFora);
    const db = executor(a);
    const d = await s.iniciarDesafio({ cpf, canal: "WHATSAPP", escopo: escopo(c) }, db);
    await assert.rejects(s.receberCodigoPorEmail(d.validacaoId, db), (e: unknown) => (e as { code?: string }).code === "FALHA_ENVIO_OTP");
    assert.deepEqual((await linhas(a, cpf)).map((l) => [l.canal, l.status, l.envios]), [["WHATSAPP", "PENDENTE", 1], ["EMAIL", "CANCELADA", 1]]);
    // O cliente pode tentar o e-mail de novo (herda 1 envio do WhatsApp; o cancelado do e-mail não conta).
    emailFora = false;
    await a.query("SAVEPOINT de_novo");
    const e = await s.receberCodigoPorEmail(d.validacaoId, db);
    assert.deepEqual((await linhas(a, cpf)).filter((l) => l.status === "PENDENTE").map((l) => [l.id === e.validacaoId, l.envios]), [[true, 2]]);
    await a.query("ROLLBACK TO SAVEPOINT de_novo");
    // Ou confirmar o código do WhatsApp que chegou atrasado.
    assert.ok((await s.confirmarCodigo({ validacaoId: d.validacaoId, codigo: enviados[0].codigo }, db)).provaToken);
  });
});

test("5. reabrirValidacaoCancelada recusa expirado, confirmado e o que não está CANCELADA", { skip: !opt(), timeout: 300_000 }, async () => {
  await emTx(async () => {
    const repo = carregar<typeof import("./repositories/identidade.repository.ts")>("lib/identidade/repositories/identidade.repository.ts");
    const c = await cenario(a, 0);
    const cpf = await clientePf(a, c);
    const s = servico([], nunca);
    const db = executor(a);
    const novo = async () => (await s.iniciarDesafio({ cpf, canal: "WHATSAPP", escopo: escopo(c) }, db)).validacaoId;
    // PENDENTE não "reabre".
    const pendente = await novo();
    assert.equal(await repo.reabrirValidacaoCancelada(pendente, db), null);
    // Expirado: não volta.
    const expirado = await novo();
    await a.query(`UPDATE validacoes_identidade_cliente SET status = 'CANCELADA', criado_em = now() - interval '20 minutes',
        codigo_expira_em = now() - interval '1 minute' WHERE id = $1::uuid`, [expirado]);
    assert.equal(await repo.reabrirValidacaoCancelada(expirado, db), null);
    // Com prova (confirmado): não volta (e voltaria a violar a pendente_check).
    const confirmado = await novo();
    await a.query(`UPDATE validacoes_identidade_cliente SET status = 'CANCELADA', confirmado_em = now(), token_prova_hash = $2,
        prova_expira_em = now() + interval '10 minutes' WHERE id = $1::uuid`, [confirmado, "f".repeat(64)]);
    assert.equal(await repo.reabrirValidacaoCancelada(confirmado, db), null);
    // A pendente_check de fato recusaria a reabertura do confirmado sem o filtro.
    await a.query("SAVEPOINT prova_check");
    await assert.rejects(a.query("UPDATE validacoes_identidade_cliente SET status = 'PENDENTE' WHERE id = $1::uuid", [confirmado]),
      (e: unknown) => (e as { code?: string; constraint?: string }).code === "23514" && /pendente_check/.test(String((e as { constraint?: string }).constraint)));
    await a.query("ROLLBACK TO SAVEPOINT prova_check");
    // Cancelado válido: reabre e passa pela pendente_check.
    const cancelado = await novo();
    assert.ok(await repo.cancelarValidacaoPendente(cancelado, db));
    assert.equal((await repo.reabrirValidacaoCancelada(cancelado, db))?.status, "PENDENTE");
    assert.equal(await repo.cancelarValidacaoPendente(cancelado, db).then((r) => r?.status), "CANCELADA");
    assert.equal(await repo.cancelarValidacaoPendente(cancelado, db), null, "cancelar de novo não muda nada");
  });
});

/** Cenário GRAVADO (as corridas precisam de duas conexões): cliente sintético com um desafio WhatsApp já enviado. */
async function gravado(enviados: Envio[]) {
  await a.query("BEGIN");
  try {
    const c = await cenario(a, 0);
    const cpf = await clientePf(a, c);
    const d = await servico(enviados, nunca).iniciarDesafio({ cpf, canal: "WHATSAPP", escopo: escopo(c) }, executor(a));
    await a.query("COMMIT");
    return { cpf, validacaoId: d.validacaoId };
  } catch (e) { await a.query("ROLLBACK"); throw e; }
}
const pidDe = async (k: Client) => Number((await k.query<{ p: number }>("SELECT pg_backend_pid() AS p")).rows[0].p);
async function esperarBloqueio(obs: Client, pid: number, por: number) {
  for (let i = 0; i < 100; i++) {
    const r = await obs.query<{ ok: boolean }>("SELECT $2::int = ANY(pg_blocking_pids($1::int)) AS ok", [pid, por]);
    if (r.rows[0]?.ok) return true;
    await new Promise((f) => setTimeout(f, 100));
  }
  return false;
}

test("6. corrida REAL: dois cliques no botão em conexões diferentes → um vence, o outro VALIDACAO_NAO_PENDENTE", { skip: !opt(), timeout: 300_000 }, async () => {
  const enviados: Envio[] = [];
  const { cpf, validacaoId } = await gravado(enviados);
  const [s1, s2, obs] = await Promise.all([1, 2, 3].map(() => conectarDescartavel({ travar: false })));
  try {
    const servicoCorrida = servico(enviados, nunca);
    // Conexão 1: clique completo dentro de uma transação aberta (segura a linha do desafio do WhatsApp).
    await s1.query("BEGIN");
    const r1 = await servicoCorrida.receberCodigoPorEmail(validacaoId, executor(s1) as DbExecutor);
    // Conexão 2: o mesmo clique lê o desafio ainda PENDENTE (antes do COMMIT) e espera na linha.
    const p2 = servicoCorrida.receberCodigoPorEmail(validacaoId, executor(s2) as DbExecutor).then((r) => ({ r }), (e) => ({ e }));
    assert.ok(await esperarBloqueio(obs, await pidDe(s2), await pidDe(s1)), "o segundo clique espera o primeiro");
    await s1.query("COMMIT");
    const r2 = await p2;
    assert.ok("e" in r2, "o segundo clique perde");
    assert.equal((r2.e as { code?: string }).code, "VALIDACAO_NAO_PENDENTE");
    assert.equal(r1.canal, "EMAIL");
    assert.deepEqual((await linhas(a, cpf)).map((l) => [l.canal, l.status, l.envios]), [["WHATSAPP", "CANCELADA", 1], ["EMAIL", "PENDENTE", 2]]);
    assert.deepEqual(enviados.map((e) => e.canal), ["WHATSAPP", "EMAIL"], "um só e-mail enviado");
  } finally { for (const k of [s1, s2, obs]) await k.end().catch(() => undefined); }
});

test("7. corrida REAL: clique durante a reabertura (e-mail falhou na outra conexão) → segue sobre o desafio reaberto; um só PENDENTE", { skip: !opt(), timeout: 300_000 }, async () => {
  const enviados: Envio[] = [];
  const { cpf, validacaoId } = await gravado(enviados);
  const [s1, s2, obs] = await Promise.all([1, 2, 3].map(() => conectarDescartavel({ travar: false })));
  try {
    // Conexão 1: o e-mail falha; cancela, cria e descarta o desafio do e-mail e reabre o WhatsApp, sem COMMIT ainda.
    await s1.query("BEGIN");
    await assert.rejects(servico(enviados, (canal) => canal === "EMAIL").receberCodigoPorEmail(validacaoId, executor(s1) as DbExecutor),
      (e: unknown) => (e as { code?: string }).code === "FALHA_ENVIO_OTP");
    // Conexão 2: novo clique (e-mail de volta) espera a linha.
    const p2 = servico(enviados, nunca).receberCodigoPorEmail(validacaoId, executor(s2) as DbExecutor).then((r) => ({ r }), (e) => ({ e }));
    assert.ok(await esperarBloqueio(obs, await pidDe(s2), await pidDe(s1)), "o clique espera a reabertura");
    await s1.query("COMMIT");
    const r2 = await p2;
    assert.ok("r" in r2, `o clique segue sobre o desafio reaberto: ${"e" in r2 ? (r2.e as { code?: string }).code : ""}`);
    const fim = await linhas(a, cpf);
    assert.deepEqual(fim.filter((l) => l.status === "PENDENTE").map((l) => [l.id === r2.r.validacaoId, l.canal, l.envios]), [[true, "EMAIL", 2]]);
    assert.deepEqual(fim.map((l) => [l.canal, l.status]), [["WHATSAPP", "CANCELADA"], ["EMAIL", "CANCELADA"], ["EMAIL", "PENDENTE"]]);
  } finally { for (const k of [s1, s2, obs]) await k.end().catch(() => undefined); }
});

// --- 8: contrato (P3) com a trava desligada, pelo serviço público real.
const MODELO = {
  titulo: "Contrato Reserva", contratada: { nome: "Buffet Sintético Ltda", documento: "12.345.678/0001-90", endereco: "Rua Teste, 2", representante: "Pessoa Teste" },
  preambulo: [], observacoes: [], cidadeAssinatura: "Cidade Teste",
  clausulas: [{ titulo: "Objeto", texto: "Festa em {{festa.data}} das {{festa.inicio}} às {{festa.fim}} ({{festa.pacote}}), {{festa.convidados}} convidados, {{valor.total}}, {{pagamento.condicao}}." }],
};
type Operar = Parameters<typeof congelarEAssinarKidmais>[1];

test("8. contrato com a trava desligada: EMAIL → CANAL_INDISPONIVEL 400 (P3); WhatsApp segue", { skip: !opt(), timeout: 300_000 }, async () => {
  const antes = process.env.IDENTIDADE_OTP_EMAIL_RESERVA;
  delete process.env.IDENTIDADE_OTP_EMAIL_RESERVA;
  try {
    await emTx(async () => {
      const c = await cenario(a, 0);
      const nativo = await catalogoNativo(a, c);
      await a.query(`INSERT INTO modelos_contrato_empresa (empresa_id, versao, conteudo, conteudo_sha256, aprovado_por) VALUES ($1::uuid, 1, $2::jsonb, $3, $4::uuid)`,
        [c.empresa, JSON.stringify(MODELO), "a".repeat(64), c.usuario]);
      const cpf = await clientePf(a, c);
      const clienteId = (await a.query<{ id: string }>("SELECT id::text AS id FROM clientes WHERE cpf = $1", [cpf])).rows[0].id;
      const aniversariante = await id(a, `INSERT INTO aniversariantes (cliente_id, nome) VALUES ($1::uuid, 'Aniversariante') RETURNING id`, [clienteId]);
      await travarConfiguracaoAgenda(executor(a), c.empresa, { modo: "COMPARTILHADA", linha: "KEY_SHARE" });
      const festa = await id(a, `INSERT INTO fechamentos (data_evento, horario_inicio, horario_fim, configuracao_agenda_id, empresa_id, pacote_id, tabela_preco_id, preco_pacote_id,
            categoria_horario, categoria_preco_aplicada, convidados, convidados_faturados, valor_pacote_base, valor_pacote_aplicado, valor_tabela, origem_fechamento, cliente_id, aniversariante_id, status)
          SELECT $1::date, '10:00', '22:00', $2::uuid, $3::uuid, p.id, pp.tabela_preco_id, pp.id, 'PADRAO', 'PADRAO', 30, 30, 100, 100, 100, 'ATENDIMENTO_KIDMAIS', $5::uuid, $6::uuid, 'AGUARDANDO_CONTRATO'
            FROM pacotes p JOIN precos_pacote pp ON pp.pacote_id = p.id WHERE p.id = $4::uuid LIMIT 1 RETURNING fechamentos.id`,
        [dia(140), nativo.turno, c.empresa, c.pacote, clienteId, aniversariante]);
      const contratos = carregar<typeof import("../contratos/services/contrato.service.ts")>("lib/contratos/services/contrato.service.ts");
      const gerado = await contratos.gerarContrato({ fechamentoId: festa } as never, { usuarioId: c.usuario, origem: "SISTEMA", executor: executor(a) } as never) as { contrato: { id: string }; versao: { id: string } };
      const adm = carregar<typeof import("../contratos/services/administrativo.service.ts")>("lib/contratos/services/administrativo.service.ts");
      await congelarEAssinarKidmais(a, adm.operarContrato as unknown as Operar, gerado.versao.id, c.empresa, c.token, nativo.tokenRepresentante);
      const publico = carregar<typeof import("../contratos/services/contrato-publico.service.ts")>("lib/contratos/services/contrato-publico.service.ts");
      const enviados: string[] = [];
      const emissor = (async (x: { canal: string }) => { enviados.push(x.canal); }) as never;
      await recusa(() => publico.iniciarDesafioContrato({ contratoId: gerado.contrato.id, cpf, canal: "EMAIL" }, emissor), "CANAL_INDISPONIVEL", 400);
      assert.deepEqual(enviados, []);
      const d = await publico.iniciarDesafioContrato({ contratoId: gerado.contrato.id, cpf, canal: "WHATSAPP" }, emissor);
      assert.ok(d.validacaoId);
      assert.deepEqual(enviados, ["WHATSAPP"]);
    });
  } finally {
    if (antes === undefined) delete process.env.IDENTIDADE_OTP_EMAIL_RESERVA; else process.env.IDENTIDADE_OTP_EMAIL_RESERVA = antes;
  }
});
