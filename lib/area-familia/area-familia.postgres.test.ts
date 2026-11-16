import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";
import {
  ambienteAssinatura, assinarComoCliente, carregar, catalogoNativo, cenario, congelarEAssinarKidmais, cpfValido, dia, executor, id, poolNaTransacao, validarAgora,
  type Cenario,
} from "../../scripts/integracao-importados-test-support.ts";
import { travarConfiguracaoAgenda } from "../agenda/trava-configuracao.ts";

/**
 * Área "Minha festa" (123, F1) no PostgreSQL DESCARTÁVEL, modelo 123. Festa real (contrato gerado, assinado pelo buffet
 * e pelo cliente pelo fluxo público). Cobre: entrada do contratante e do segundo responsável (link + documento + código),
 * cookie de 12 h / 30 dias, recusas (documento, outra empresa, link trocado, pessoa removida, contrato cancelado, festa
 * invalidada, área fechada), limites por pessoa, sair / sair de todos / desconectar todos, painel do buffet e as travas
 * do banco (sem CONFIRMADA, sessão só com prova consumida, serviço genérico recusa AREA_FAMILIA).
 * Cada teste termina em ROLLBACK; a sessão nasce com SET CONSTRAINTS ALL IMMEDIATE para o gatilho diferido rodar.
 */
const opt = () => process.env.KIDMAIS_POSTGRES_DESCARTAVEL === "kidmais_pacotes_v1_descartavel";
let a: Client;
let com123 = false;
type Operar = Parameters<typeof congelarEAssinarKidmais>[1];
const MODELO = {
  titulo: "Contrato", contratada: { nome: "Buffet Teste Ltda", documento: "12.345.678/0001-90", endereco: "Rua Teste, 2", representante: "Pessoa Teste" },
  preambulo: [], observacoes: [], cidadeAssinatura: "Cidade Teste",
  clausulas: [{ titulo: "Objeto", texto: "Festa em {{festa.data}} das {{festa.inicio}} às {{festa.fim}} ({{festa.pacote}}), {{festa.convidados}} convidados, {{valor.total}}, {{pagamento.condicao}}. {{contratante.tipo_documento}} {{contratante.documento}}." }],
};

const acesso = () => carregar<typeof import("./acesso.ts")>("lib/area-familia/acesso.ts");
const admin = () => carregar<typeof import("./admin.ts")>("lib/area-familia/admin.ts");
const limites = () => carregar<typeof import("./limites.ts")>("lib/area-familia/limites.ts");

async function emTx(corpo: () => Promise<void>) {
  await a.query("BEGIN");
  const restaurarPool = poolNaTransacao(a);
  const restaurarAmbiente = ambienteAssinatura();
  try { await corpo(); } finally { await a.query("ROLLBACK"); restaurarAmbiente(); restaurarPool(); }
}
async function recusa<T>(p: () => Promise<T>, f: (e: unknown) => boolean) {
  await a.query("SAVEPOINT recusa");
  await assert.rejects(p(), f);
  await a.query("ROLLBACK TO SAVEPOINT recusa");
}
const codigoErro = (codigo: string) => (e: unknown) => (e as { code?: string }).code === codigo;
const pepper = () => process.env.IDENTIDADE_OTP_PEPPER as string;

type Festa = { c: Cenario; festaId: string; contratoId: string; codigo: string; cpf: string; clienteId: string; ctx: { empresaId: string; usuarioId: string } };

/** Empresa ATIVA com catálogo, cliente PF completo, contrato assinado pelos dois lados: a festa nasce na formalização. */
async function festa(diasAteFesta = 130): Promise<Festa> {
  const c = await cenario(a, 0);
  const nativo = await catalogoNativo(a, c);
  await a.query(`INSERT INTO modelos_contrato_empresa (empresa_id, versao, conteudo, conteudo_sha256, aprovado_por) VALUES ($1::uuid, 1, $2::jsonb, $3, $4::uuid)`,
    [c.empresa, JSON.stringify(MODELO), "a".repeat(64), c.usuario]);
  const cpf = cpfValido();
  const clienteId = await id(a,
    `INSERT INTO clientes (nome_completo, cpf, empresa_id, email, telefone, whatsapp, cep, logradouro, numero, bairro, cidade, uf)
     VALUES ('Maria Contratante Silva', $1, $2::uuid, $3, '11999998888', '11999998888', '01001000', 'Rua Sintética', '1', 'Centro', 'São Paulo', 'SP') RETURNING id`,
    [cpf, c.empresa, `${randomUUID()}@example.invalid`]);
  const aniversariante = await id(a, `INSERT INTO aniversariantes (cliente_id, nome) VALUES ($1::uuid, 'Aniversariante') RETURNING id`, [clienteId]);
  await travarConfiguracaoAgenda(executor(a), c.empresa, { modo: "COMPARTILHADA", linha: "KEY_SHARE" });
  const fechamento = await id(a, `INSERT INTO fechamentos (data_evento, horario_inicio, horario_fim, configuracao_agenda_id, empresa_id, pacote_id, tabela_preco_id, preco_pacote_id,
        categoria_horario, categoria_preco_aplicada, convidados, convidados_faturados, valor_pacote_base, valor_pacote_aplicado, valor_tabela, origem_fechamento, cliente_id, aniversariante_id, status)
      SELECT $1::date, '10:00', '22:00', $2::uuid, $3::uuid, p.id, pp.tabela_preco_id, pp.id, 'PADRAO', 'PADRAO', 30, 30, 100, 100, 100, 'ATENDIMENTO_KIDMAIS', $5::uuid, $6::uuid, 'AGUARDANDO_CONTRATO'
        FROM pacotes p JOIN precos_pacote pp ON pp.pacote_id = p.id WHERE p.id = $4::uuid LIMIT 1 RETURNING fechamentos.id`,
    [dia(diasAteFesta), nativo.turno, c.empresa, c.pacote, clienteId, aniversariante]);
  const contratos = carregar<typeof import("../contratos/services/contrato.service.ts")>("lib/contratos/services/contrato.service.ts");
  const gerado = await contratos.gerarContrato({ fechamentoId: fechamento } as never, { usuarioId: c.usuario, origem: "SISTEMA", executor: executor(a) } as never) as { contrato: { id: string }; versao: { id: string } };
  const adm = carregar<typeof import("../contratos/services/administrativo.service.ts")>("lib/contratos/services/administrativo.service.ts");
  await congelarEAssinarKidmais(a, adm.operarContrato as unknown as Operar, gerado.versao.id, c.empresa, c.token, nativo.tokenRepresentante);
  await assinarComoCliente(gerado.contrato.id, cpf);
  const festaId = (await a.query<{ id: string }>("SELECT id::text AS id FROM festas WHERE contrato_id = $1::uuid", [gerado.contrato.id])).rows[0]?.id;
  assert.ok(festaId, "a festa nasce na formalização");
  const codigo = (await a.query<{ codigo: string }>("SELECT codigo FROM empresas WHERE id = $1::uuid", [c.empresa])).rows[0].codigo;
  return { c, festaId, contratoId: gerado.contrato.id, codigo, cpf, clienteId, ctx: { empresaId: c.empresa, usuarioId: c.usuario } };
}

const tokenDo = (caminho: string) => caminho.split("#")[1];

/** Entrada completa: pede o código (capturado do envio) e confirma. Devolve o token do cookie. */
async function entrar(f: Festa, token: string, documento: string | null, lembrar = false) {
  let codigo = "";
  const deps = { pepper: pepper(), enviarOtp: async (x: { codigo: string }) => { codigo = x.codigo; } };
  const inicio = await acesso().iniciarEntrada(executor(a), deps as never, { empresaCodigo: f.codigo, token, documento });
  assert.equal(inicio.ok, true, `entrada recusada: ${JSON.stringify(inicio)}`);
  const ok = inicio as { validacaoId: string; destinoMascarado: string };
  const r = await acesso().confirmarEntrada(executor(a), { pepper: pepper() }, { empresaCodigo: f.codigo, validacaoId: ok.validacaoId, codigo, lembrar, aparelho: "Chrome no Android" });
  assert.equal(r.ok, true, `confirmação recusada: ${JSON.stringify(r)}`);
  await validarAgora(a);
  return { ...(r as { token: string; expiraEm: Date; sessaoId: string }), validacaoId: ok.validacaoId, destino: ok.destinoMascarado };
}
const iniciar = (f: Festa, token: string, documento: string | null, enviarOtp: (x: { codigo: string }) => Promise<void> = async () => {}) =>
  acesso().iniciarEntrada(executor(a), { pepper: pepper(), enviarOtp } as never, { empresaCodigo: f.codigo, token, documento });
const sessao = (f: Festa, token: string) => acesso().lerSessao(executor(a), f.codigo, token);
const horas = (d: Date) => (d.getTime() - Date.now()) / 3_600_000;

test.before(async () => {
  if (!opt()) return;
  process.env.FESTA_ENABLED = "true";
  a = await conectarDescartavel();
  com123 = (await a.query("SELECT to_regclass('public.festa_pessoas') IS NOT NULL AS ok")).rows[0].ok;
});
test.after(async () => { if (a) await encerrarDescartavel(a); });

test("123: o módulo Festa segue disponível (a 123 não toca a estrutura conferida das tabelas da Festa)", { skip: !opt(), timeout: 60_000 }, async (t) => {
  if (!com123) return t.skip("modelo sem a 123");
  const ambiente = carregar<typeof import("../festas/ambiente.ts")>("lib/festas/ambiente.ts");
  await emTx(async () => { await ambiente.validarAmbienteFesta(executor(a)); });
});

test("123: contratante e segundo responsável entram (link + documento + código) e veem a área; 12 h sem lembrar, 30 dias com", { skip: !opt(), timeout: 300_000 }, async (t) => {
  if (!com123) return t.skip("modelo sem a 123");
  await emTx(async () => {
    const f = await festa();
    const link = await admin().gerarLinkArea(executor(a), f.ctx, f.festaId, "CONTRATANTE");
    assert.match(link.caminho, new RegExp(`^/b/${f.codigo}/minha-festa#[A-Za-z0-9_-]{43}$`));
    // O banco guarda só o hash: o token não aparece em nenhuma coluna.
    const guardado = (await a.query("SELECT token_hash FROM festa_links_area WHERE festa_id = $1::uuid", [f.festaId])).rows;
    assert.equal(guardado.length, 1);
    assert.notEqual(guardado[0].token_hash, tokenDo(link.caminho));

    // Código errado conta tentativa e não abre sessão.
    let codigo = "";
    const inicio = await iniciar(f, tokenDo(link.caminho), f.cpf.replace(/^(\d{3})(\d{3})(\d{3})/, "$1.$2.$3-"), async (x: { codigo: string }) => { codigo = x.codigo; }) as { ok: true; validacaoId: string; destinoMascarado: string };
    assert.equal(inicio.ok, true);
    assert.ok(!inicio.destinoMascarado.includes("99999888"), "destino mascarado");
    const errado = codigo === "000000" ? "111111" : "000000";
    const r1 = await acesso().confirmarEntrada(executor(a), { pepper: pepper() }, { empresaCodigo: f.codigo, validacaoId: inicio.validacaoId, codigo: errado, lembrar: false, aparelho: null });
    assert.deepEqual(r1, { ok: false, motivo: "CODIGO_INCORRETO" });
    assert.equal((await a.query("SELECT tentativas FROM validacoes_identidade_cliente WHERE id = $1::uuid", [inicio.validacaoId])).rows[0].tentativas, 1);
    const r2 = await acesso().confirmarEntrada(executor(a), { pepper: pepper() }, { empresaCodigo: f.codigo, validacaoId: inicio.validacaoId, codigo, lembrar: false, aparelho: "Safari no iPhone" }) as { ok: true; token: string; expiraEm: Date; sessaoId: string };
    assert.equal(r2.ok, true);
    await validarAgora(a);
    assert.ok(Math.abs(horas(r2.expiraEm) - 12) < 0.2, "sem lembrar: 12 h");
    const v = (await a.query("SELECT status, codigo_hash, consumido_por_area_sessao_id::text AS s FROM validacoes_identidade_cliente WHERE id = $1::uuid", [inicio.validacaoId])).rows[0];
    assert.deepEqual(v, { status: "CONSUMIDA", codigo_hash: null, s: r2.sessaoId });
    // Mesmo código de novo: recusa (já consumido).
    assert.deepEqual(await acesso().confirmarEntrada(executor(a), { pepper: pepper() }, { empresaCodigo: f.codigo, validacaoId: inicio.validacaoId, codigo, lembrar: false, aparelho: null }), { ok: false, motivo: "RECUSADO" });
    const s1 = await sessao(f, r2.token);
    assert.equal(s1?.papel, "CONTRATANTE");
    assert.equal(s1?.primeiroNome, "Maria");
    assert.equal(await acesso().lerSessao(executor(a), "outra-empresa", r2.token), null, "cookie só vale no endereço da empresa");

    // Segundo responsável com CPF: precisa informar; o código vai ao WhatsApp DELE.
    const cpf2 = cpfValido();
    await admin().cadastrarSegundo(executor(a), f.ctx, f.festaId, { nome: "João Segundo", whatsapp: "(21) 98888-7777", documento: cpf2 }, pepper());
    const doc = (await a.query("SELECT documento_hash FROM festa_pessoas WHERE festa_id = $1::uuid AND papel = 'SEGUNDO_RESPONSAVEL'", [f.festaId])).rows[0].documento_hash;
    assert.ok(doc && !String(doc).includes(cpf2), "CPF do segundo só como HMAC");
    const link2 = await admin().gerarLinkArea(executor(a), f.ctx, f.festaId, "SEGUNDO_RESPONSAVEL");
    assert.deepEqual(await iniciar(f, tokenDo(link2.caminho), null), { ok: false, motivo: "RECUSADO" });
    assert.deepEqual(await iniciar(f, tokenDo(link2.caminho), f.cpf), { ok: false, motivo: "RECUSADO" }, "CPF do contratante não abre o link do segundo");
    const e2 = await entrar(f, tokenDo(link2.caminho), cpf2, true);
    assert.match(e2.destino, /7777$/);
    assert.ok(Math.abs(horas(e2.expiraEm) - 24 * 30) < 0.5, "com lembrar: 30 dias");
    assert.equal((await sessao(f, e2.token))?.papel, "SEGUNDO_RESPONSAVEL");
    assert.equal((await sessao(f, e2.token))?.primeiroNome, "João");

    // Painel: duas pessoas com link, dois aparelhos, sem token nem CPF.
    const resumo = await admin().resumoAreaFamilia(executor(a), f.ctx, f.festaId);
    assert.equal(resumo.aberta, true);
    assert.deepEqual(resumo.pessoas.map((p) => [p.papel, !!p.linkAtivoAte]), [["CONTRATANTE", true], ["SEGUNDO_RESPONSAVEL", true]]);
    assert.equal(resumo.aparelhos.length, 2);
    const texto = JSON.stringify(resumo);
    for (const proibido of [f.cpf, cpf2, tokenDo(link.caminho), tokenDo(link2.caminho), "11999998888", "21988887777"]) assert.ok(!texto.includes(proibido));
    const eventos = (await a.query("SELECT tipo FROM area_familia_eventos WHERE festa_id = $1::uuid ORDER BY criado_em, tipo", [f.festaId])).rows.map((r) => r.tipo);
    assert.deepEqual([...eventos].sort(), ["ENTRADA", "ENTRADA", "LINK_GERADO", "LINK_GERADO", "PESSOA_CADASTRADA"]);
  });
});

test("123: segundo responsável sem CPF entra com documento em branco; CPF do segundo inválido e segundo duplicado recusados", { skip: !opt(), timeout: 300_000 }, async (t) => {
  if (!com123) return t.skip("modelo sem a 123");
  await emTx(async () => {
    const f = await festa();
    await recusa(() => admin().cadastrarSegundo(executor(a), f.ctx, f.festaId, { nome: "Ana", whatsapp: "123" }, pepper()), codigoErro("DADOS_INVALIDOS"));
    await recusa(() => admin().cadastrarSegundo(executor(a), f.ctx, f.festaId, { nome: "Ana", whatsapp: "11977776666", documento: "123" }, pepper()), codigoErro("DADOS_INVALIDOS"));
    await admin().cadastrarSegundo(executor(a), f.ctx, f.festaId, { nome: "Ana Segunda", whatsapp: "11977776666" }, pepper());
    await recusa(() => admin().cadastrarSegundo(executor(a), f.ctx, f.festaId, { nome: "Outra", whatsapp: "11966665555" }, pepper()), codigoErro("SEGUNDO_JA_CADASTRADO"));
    const link = await admin().gerarLinkArea(executor(a), f.ctx, f.festaId, "SEGUNDO_RESPONSAVEL");
    const e = await entrar(f, tokenDo(link.caminho), "");
    assert.equal((await sessao(f, e.token))?.papel, "SEGUNDO_RESPONSAVEL");
  });
});

test("123: recusas iguais — documento errado, outra empresa, link trocado, token malformado; sem segundo não há link", { skip: !opt(), timeout: 300_000 }, async (t) => {
  if (!com123) return t.skip("modelo sem a 123");
  await emTx(async () => {
    const f = await festa();
    const outra = await festa(140);
    const RECUSADO = { ok: false, motivo: "RECUSADO" };
    await recusa(() => admin().gerarLinkArea(executor(a), f.ctx, f.festaId, "SEGUNDO_RESPONSAVEL"), codigoErro("SEGUNDO_AUSENTE"));
    const velho = tokenDo((await admin().gerarLinkArea(executor(a), f.ctx, f.festaId, "CONTRATANTE")).caminho);
    const novo = tokenDo((await admin().gerarLinkArea(executor(a), f.ctx, f.festaId, "CONTRATANTE")).caminho);
    assert.deepEqual(await iniciar(f, velho, f.cpf), RECUSADO, "link anterior cai com o novo");
    assert.deepEqual(await iniciar(f, novo, cpfValido()), RECUSADO, "documento de outra pessoa");
    assert.deepEqual(await iniciar(f, novo, null), RECUSADO, "contratante sem documento");
    assert.deepEqual(await iniciar(f, novo, outra.cpf), RECUSADO, "CPF do cliente de outra empresa");
    assert.deepEqual(await iniciar({ ...f, codigo: outra.codigo }, novo, f.cpf), RECUSADO, "link no endereço de outra empresa");
    assert.deepEqual(await iniciar(f, "x".repeat(42), f.cpf), RECUSADO);
    assert.deepEqual(await iniciar({ ...f, codigo: "Empresa_Invalida" }, novo, f.cpf), RECUSADO);
    // Buffet de outra empresa não enxerga nem age na festa (404 igual a inexistente).
    await recusa(() => admin().resumoAreaFamilia(executor(a), outra.ctx, f.festaId), codigoErro("FESTA_NAO_ENCONTRADA"));
    await recusa(() => admin().gerarLinkArea(executor(a), outra.ctx, f.festaId, "CONTRATANTE"), codigoErro("FESTA_NAO_ENCONTRADA"));
    await recusa(() => admin().resumoAreaFamilia(executor(a), f.ctx, randomUUID()), codigoErro("FESTA_NAO_ENCONTRADA"));
    assert.equal((await iniciar(f, novo, f.cpf)).ok, true, "o link atual com o CPF certo segue valendo");
  });
});

test("123: contrato cancelado, festa invalidada, pessoa removida e área fechada derrubam sessão e link", { skip: !opt(), timeout: 600_000 }, async (t) => {
  if (!com123) return t.skip("modelo sem a 123");
  await emTx(async () => {
    // Pessoa removida: sessão e link dela caem; o contratante segue.
    const f = await festa();
    const lc = tokenDo((await admin().gerarLinkArea(executor(a), f.ctx, f.festaId, "CONTRATANTE")).caminho);
    const ec = await entrar(f, lc, f.cpf);
    const segundoId = (await admin().cadastrarSegundo(executor(a), f.ctx, f.festaId, { nome: "Bia", whatsapp: "11955554444" }, pepper())).id;
    const ls = tokenDo((await admin().gerarLinkArea(executor(a), f.ctx, f.festaId, "SEGUNDO_RESPONSAVEL")).caminho);
    const es = await entrar(f, ls, null);
    await admin().removerSegundo(executor(a), f.ctx, f.festaId, segundoId);
    assert.equal(await sessao(f, es.token), null);
    assert.deepEqual(await iniciar(f, ls, null), { ok: false, motivo: "RECUSADO" });
    assert.ok(await sessao(f, ec.token));
    await recusa(() => admin().removerSegundo(executor(a), f.ctx, f.festaId, segundoId), codigoErro("PESSOA_NAO_ENCONTRADA"));
    const motivo = (await a.query("SELECT motivo_revogacao FROM area_familia_sessoes WHERE id = $1::uuid", [es.sessaoId])).rows[0].motivo_revogacao;
    assert.equal(motivo, "PESSOA_REMOVIDA");

    // Contrato cancelado.
    await a.query("UPDATE contratos SET status = 'CANCELADO', cancelado_em = now() WHERE id = $1::uuid", [f.contratoId]);
    assert.equal(await sessao(f, ec.token), null, "contrato cancelado: sessão cai");
    assert.deepEqual(await iniciar(f, lc, f.cpf), { ok: false, motivo: "RECUSADO" });
    assert.equal((await admin().resumoAreaFamilia(executor(a), f.ctx, f.festaId)).aberta, false);
    await recusa(() => admin().gerarLinkArea(executor(a), f.ctx, f.festaId, "CONTRATANTE"), codigoErro("AREA_INDISPONIVEL"));

    // Festa invalidada.
    const g = await festa(150);
    const lg = tokenDo((await admin().gerarLinkArea(executor(a), g.ctx, g.festaId, "CONTRATANTE")).caminho);
    const eg = await entrar(g, lg, g.cpf);
    // Com contrato assinado o banco (019) só deixa invalidar via cancelamento; aqui só o predicado da área está em teste.
    await a.query("SET LOCAL session_replication_role = replica");
    await a.query("UPDATE festas SET invalidada_em = clock_timestamp(), invalidada_por = $2::uuid, motivo_invalidacao = 'teste da área' WHERE id = $1::uuid", [g.festaId, g.ctx.usuarioId]);
    await a.query("SET LOCAL session_replication_role = origin");
    assert.equal(await sessao(g, eg.token), null, "festa invalidada: sessão cai");
    assert.deepEqual(await iniciar(g, lg, g.cpf), { ok: false, motivo: "RECUSADO" });

    // Área fechada (festa há mais de 30 dias): data movida sem gatilhos (só o predicado de tempo está em teste).
    const h = await festa(160);
    const lh = tokenDo((await admin().gerarLinkArea(executor(a), h.ctx, h.festaId, "CONTRATANTE")).caminho);
    const eh = await entrar(h, lh, h.cpf);
    await a.query("SET LOCAL session_replication_role = replica");
    await a.query("UPDATE fechamentos SET data_evento = current_date - 31 WHERE id = (SELECT fechamento_id FROM contratos WHERE id = $1::uuid)", [h.contratoId]);
    await a.query("SET LOCAL session_replication_role = origin");
    assert.equal(await sessao(h, eh.token), null, "área fechada: sessão não vale");
    assert.deepEqual(await iniciar(h, lh, h.cpf), { ok: false, motivo: "RECUSADO" });
    const fechado = await admin().resumoAreaFamilia(executor(a), h.ctx, h.festaId);
    assert.equal(fechado.aberta, false);
    // Exatamente 30 dias depois a área ainda está aberta (fecha no fim do 30º dia, horário de Brasília).
    await a.query("SET LOCAL session_replication_role = replica");
    await a.query("UPDATE fechamentos SET data_evento = (now() AT TIME ZONE 'America/Sao_Paulo')::date - 30 WHERE id = (SELECT fechamento_id FROM contratos WHERE id = $1::uuid)", [h.contratoId]);
    await a.query("SET LOCAL session_replication_role = origin");
    assert.ok(await sessao(h, eh.token), "30º dia: ainda aberta");
  });
});

test("123: limites por pessoa — 3 códigos por hora; 5 erros bloqueiam o código; 10 erros no dia travam a pessoa", { skip: !opt(), timeout: 300_000 }, async (t) => {
  if (!com123) return t.skip("modelo sem a 123");
  await emTx(async () => {
    const f = await festa();
    const token = tokenDo((await admin().gerarLinkArea(executor(a), f.ctx, f.festaId, "CONTRATANTE")).caminho);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await iniciar(f, token, f.cpf) as { ok: true; validacaoId: string };
      assert.equal(r.ok, true);
      ids.push(r.validacaoId);
    }
    assert.deepEqual(await iniciar(f, token, f.cpf), { ok: false, motivo: "LIMITE" });
    // Código novo cancela o pendente anterior.
    const status = (await a.query("SELECT status FROM validacoes_identidade_cliente WHERE id = ANY($1::uuid[]) ORDER BY criado_em", [ids])).rows.map((r) => r.status);
    assert.deepEqual(status.filter((s) => s === "PENDENTE").length, 1);
    const atual = ids[2];
    for (let i = 0; i < 5; i++) {
      assert.deepEqual(await acesso().confirmarEntrada(executor(a), { pepper: pepper() }, { empresaCodigo: f.codigo, validacaoId: atual, codigo: "000001", lembrar: false, aparelho: null }), { ok: false, motivo: "CODIGO_INCORRETO" });
    }
    assert.equal((await a.query("SELECT status FROM validacoes_identidade_cliente WHERE id = $1::uuid", [atual])).rows[0].status, "BLOQUEADA");
    assert.deepEqual(await acesso().confirmarEntrada(executor(a), { pepper: pepper() }, { empresaCodigo: f.codigo, validacaoId: atual, codigo: "000001", lembrar: false, aparelho: null }), { ok: false, motivo: "RECUSADO" });
    // Erros do dia não zeram com código novo: 10 no dia travam (simulados nas validações antigas, fora da janela de 1 h).
    await a.query("UPDATE validacoes_identidade_cliente SET criado_em = criado_em - interval '2 hours' WHERE id = ANY($1::uuid[])", [ids]);
    await a.query("UPDATE validacoes_identidade_cliente SET tentativas = 5, status = 'BLOQUEADA' WHERE id = $1::uuid", [ids[0]]);
    assert.deepEqual(await iniciar(f, token, f.cpf), { ok: false, motivo: "LIMITE" });
  });
});

test("123: sair, sair de todos (só a própria pessoa) e desconectar todos (buffet)", { skip: !opt(), timeout: 300_000 }, async (t) => {
  if (!com123) return t.skip("modelo sem a 123");
  await emTx(async () => {
    const f = await festa();
    const lc = tokenDo((await admin().gerarLinkArea(executor(a), f.ctx, f.festaId, "CONTRATANTE")).caminho);
    const c1 = await entrar(f, lc, f.cpf);
    const c2 = await entrar(f, lc, f.cpf, true);
    const c3 = await entrar(f, lc, f.cpf);
    await admin().cadastrarSegundo(executor(a), f.ctx, f.festaId, { nome: "Caio", whatsapp: "11944443333" }, pepper());
    const s1 = await entrar(f, tokenDo((await admin().gerarLinkArea(executor(a), f.ctx, f.festaId, "SEGUNDO_RESPONSAVEL")).caminho), null);

    await acesso().sair(executor(a), (await sessao(f, c1.token))!);
    assert.equal(await sessao(f, c1.token), null);
    assert.ok(await sessao(f, c2.token));
    await acesso().sairDeTodos(executor(a), (await sessao(f, c2.token))!);
    assert.equal(await sessao(f, c2.token), null);
    assert.equal(await sessao(f, c3.token), null);
    assert.ok(await sessao(f, s1.token), "o outro responsável continua conectado");
    await a.query("UPDATE validacoes_identidade_cliente SET criado_em = criado_em - interval '2 hours' WHERE cliente_id = $1::uuid OR festa_pessoa_id IS NOT NULL", [f.clienteId]); // limite de 3 códigos/hora por pessoa
    // Link segue valendo depois de sair: entra de novo.
    const c4 = await entrar(f, lc, f.cpf);
    const r = await admin().desconectarTodos(executor(a), f.ctx, f.festaId);
    assert.equal(r.desconectados, 2);
    assert.equal(await sessao(f, c4.token), null);
    assert.equal(await sessao(f, s1.token), null);
    assert.equal((await admin().resumoAreaFamilia(executor(a), f.ctx, f.festaId)).aparelhos.length, 0);
    // Sessão revogada não volta.
    await recusa(() => a.query("UPDATE area_familia_sessoes SET revogada_em = NULL WHERE id = $1::uuid", [c1.sessaoId]), (e) => (e as { code?: string }).code === "23514");
    // Trocar o WhatsApp do cliente derruba as sessões do contratante.
    await a.query("UPDATE validacoes_identidade_cliente SET criado_em = criado_em - interval '2 hours' WHERE cliente_id = $1::uuid OR festa_pessoa_id IS NOT NULL", [f.clienteId]); // limite de 3 códigos/hora por pessoa
    const c5 = await entrar(f, lc, f.cpf);
    await a.query("UPDATE clientes SET whatsapp = '11911112222' WHERE id = $1::uuid", [f.clienteId]);
    assert.equal(await sessao(f, c5.token), null);
    const tipos = (await a.query("SELECT tipo FROM area_familia_eventos WHERE festa_id = $1::uuid", [f.festaId])).rows.map((x) => x.tipo);
    for (const tipo of ["SAIR", "SAIR_DE_TODOS", "BUFFET_DESCONECTOU"]) assert.ok(tipos.includes(tipo), tipo);
  });
});

test("123: travas do banco — sem CONFIRMADA, sessão só com prova consumida da própria pessoa, serviço genérico recusa AREA_FAMILIA", { skip: !opt(), timeout: 300_000 }, async (t) => {
  if (!com123) return t.skip("modelo sem a 123");
  await emTx(async () => {
    const f = await festa();
    const token = tokenDo((await admin().gerarLinkArea(executor(a), f.ctx, f.festaId, "CONTRATANTE")).caminho);
    let codigo = "";
    const ini = await iniciar(f, token, f.cpf, async (x: { codigo: string }) => { codigo = x.codigo; }) as { ok: true; validacaoId: string };
    // CONFIRMADA é proibida para AREA_FAMILIA (a prova não pode ficar solta).
    await recusa(() => a.query(`UPDATE validacoes_identidade_cliente SET status = 'CONFIRMADA', confirmado_em = now(), token_prova_hash = $2, prova_expira_em = now() + interval '5 minutes'
      WHERE id = $1::uuid`, [ini.validacaoId, "b".repeat(64)]), (e) => (e as { code?: string }).code === "23514");
    // Serviço genérico de identidade não confirma nem reenvia por e-mail um código da área.
    const identidade = carregar<{ criarIdentityServiceComAmbiente: (s: unknown) => { confirmarCodigo: (i: { validacaoId: string; codigo: string }) => Promise<unknown> } }>("lib/identidade/services/index.ts");
    await recusa(() => identidade.criarIdentityServiceComAmbiente(async () => {}).confirmarCodigo({ validacaoId: ini.validacaoId, codigo }), (e) => (e as { httpStatus?: number }).httpStatus === 404);
    // Sessão sem prova consumida: o gatilho diferido recusa no fim.
    const pessoa = (await a.query("SELECT id FROM festa_pessoas WHERE festa_id = $1::uuid AND papel = 'CONTRATANTE'", [f.festaId])).rows[0].id;
    await a.query("SAVEPOINT sem_prova");
    await a.query(`INSERT INTO area_familia_sessoes (pessoa_id, festa_id, empresa_id, validacao_id, token_hash, lembrar, expira_em)
      VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, false, now() + interval '1 hour')`, [pessoa, f.festaId, f.c.empresa, ini.validacaoId, "c".repeat(64)]);
    await assert.rejects(a.query("SET CONSTRAINTS ALL IMMEDIATE"), (e) => (e as { code?: string }).code === "23514");
    await a.query("ROLLBACK TO SAVEPOINT sem_prova");
    // Pessoa removida não recebe código novo nem pelo banco.
    const segundo = (await admin().cadastrarSegundo(executor(a), f.ctx, f.festaId, { nome: "Duda", whatsapp: "11933332222" }, pepper())).id;
    await admin().removerSegundo(executor(a), f.ctx, f.festaId, segundo);
    await recusa(() => a.query(`INSERT INTO validacoes_identidade_cliente (cliente_id, finalidade, festa_pessoa_id, canal, status, codigo_hash, codigo_expira_em, max_tentativas, max_envios)
      VALUES ($1::uuid, 'AREA_FAMILIA', $2::uuid, 'WHATSAPP', 'PENDENTE', $3, now() + interval '10 minutes', 5, 1)`, [f.clienteId, segundo, "d".repeat(64)]),
    (e) => (e as { code?: string }).code === "23514");
    // A entrada certa continua funcionando depois das recusas.
    const r = await acesso().confirmarEntrada(executor(a), { pepper: pepper() }, { empresaCodigo: f.codigo, validacaoId: ini.validacaoId, codigo, lembrar: false, aparelho: null });
    assert.equal(r.ok, true);
    await validarAgora(a);
  });
});

test("123: limite no banco por origem conta entre chamadas, separa regras e não grava IP em claro", { skip: !opt(), timeout: 120_000 }, async (t) => {
  if (!com123) return t.skip("modelo sem a 123");
  await emTx(async () => {
    const regra = { nome: `teste:${randomUUID()}`, limite: 2, janelaSegundos: 3600 };
    const p = "p".repeat(32);
    const contar = (origem: string | null, r = regra) => limites().consumirLimite(executor(a), r, origem, "escopo-teste", p);
    assert.equal(await contar("203.0.113.9"), null);
    assert.equal(await contar("203.0.113.9"), null);
    const espera = await contar("203.0.113.9");
    assert.ok(typeof espera === "number" && espera > 0 && espera <= 3600);
    assert.equal(await contar("203.0.113.10"), null, "outra origem tem a própria conta");
    assert.equal(await contar("203.0.113.9", { ...regra, nome: `${regra.nome}:b` }), null, "outra regra tem a própria conta");
    // Sem origem: teto 10 vezes maior por escopo.
    for (let i = 0; i < 20; i++) assert.equal(await contar(null), null);
    assert.ok(await contar(null));
    const chaves = (await a.query("SELECT chave FROM limites_contadores")).rows.map((r) => String(r.chave));
    assert.ok(chaves.every((c) => /^[0-9a-f]{64}$/.test(c)));
  });
});

test("123: cada pedido confere pessoa, contrato e cliente mesmo sem os gatilhos (defesa em profundidade)", { skip: !opt(), timeout: 600_000 }, async (t) => {
  if (!com123) return t.skip("modelo sem a 123");
  await emTx(async () => {
    // Os gatilhos da 123 revogam sessão e link nesses casos; aqui eles ficam desligados (replica) para provar que o
    // predicado SQL_ACESSO_ABERTO, sozinho, também fecha a porta.
    const semGatilhos = async (sql: string, params: unknown[]) => {
      await a.query("SET LOCAL session_replication_role = replica");
      await a.query(sql, params);
      await a.query("SET LOCAL session_replication_role = origin");
    };

    // Pessoa removida.
    const f = await festa();
    const segundoId = (await admin().cadastrarSegundo(executor(a), f.ctx, f.festaId, { nome: "Rui", whatsapp: "11933332222" }, pepper())).id;
    const ls = tokenDo((await admin().gerarLinkArea(executor(a), f.ctx, f.festaId, "SEGUNDO_RESPONSAVEL")).caminho);
    const es = await entrar(f, ls, null);
    await semGatilhos("UPDATE festa_pessoas SET removido_em = clock_timestamp(), removido_por_usuario_id = $2::uuid WHERE id = $1::uuid", [segundoId, f.ctx.usuarioId]);
    assert.equal(await sessao(f, es.token), null, "pessoa removida: sessão não vale");
    assert.deepEqual(await iniciar(f, ls, null), { ok: false, motivo: "RECUSADO" });

    // Contrato cancelado.
    const g = await festa(140);
    const lg = tokenDo((await admin().gerarLinkArea(executor(a), g.ctx, g.festaId, "CONTRATANTE")).caminho);
    const eg = await entrar(g, lg, g.cpf);
    await semGatilhos("UPDATE contratos SET status = 'CANCELADO', cancelado_em = now() WHERE id = $1::uuid", [g.contratoId]);
    assert.equal(await sessao(g, eg.token), null, "contrato cancelado: sessão não vale");
    assert.deepEqual(await iniciar(g, lg, g.cpf), { ok: false, motivo: "RECUSADO" });

    // A festa passou para outro cliente: o contratante antigo perde o acesso.
    const h = await festa(145);
    const outro = await festa(146);
    const lh = tokenDo((await admin().gerarLinkArea(executor(a), h.ctx, h.festaId, "CONTRATANTE")).caminho);
    const eh = await entrar(h, lh, h.cpf);
    await semGatilhos("UPDATE fechamentos SET cliente_id = $2::uuid WHERE id = (SELECT fechamento_id FROM contratos WHERE id = $1::uuid)", [h.contratoId, outro.clienteId]);
    assert.equal(await sessao(h, eh.token), null, "outro cliente: sessão do contratante antigo não vale");
    assert.deepEqual(await iniciar(h, lh, h.cpf), { ok: false, motivo: "RECUSADO" });
  });
});

/** Pede o código e devolve a validação e o código capturado do envio (sem confirmar). */
async function pedirCodigo(f: Festa, token: string, documento: string | null, conexao: Client = a) {
  let codigo = "";
  const r = await acesso().iniciarEntrada(executor(conexao), { pepper: pepper(), enviarOtp: async (x: { codigo: string }) => { codigo = x.codigo; } } as never,
    { empresaCodigo: f.codigo, token, documento });
  assert.equal(r.ok, true, `entrada recusada: ${JSON.stringify(r)}`);
  return { validacaoId: (r as { validacaoId: string }).validacaoId, codigo };
}
const confirmar = (f: Festa, validacaoId: string, codigo: string, conexao: Client = a) =>
  acesso().confirmarEntrada(executor(conexao), { pepper: pepper() }, { empresaCodigo: f.codigo, validacaoId, codigo, lembrar: true, aparelho: null });
const statusDa = async (validacaoId: string) =>
  (await a.query<{ status: string }>("SELECT status FROM validacoes_identidade_cliente WHERE id = $1::uuid", [validacaoId])).rows[0].status;

test("123 (AF-R1): troca de WhatsApp cancela o código pendente — contratante e segundo; sem gatilho, o código não confere com o número novo", { skip: !opt(), timeout: 600_000 }, async (t) => {
  if (!com123) return t.skip("modelo sem a 123");
  await emTx(async () => {
    const f = await festa();
    const lc = tokenDo((await admin().gerarLinkArea(executor(a), f.ctx, f.festaId, "CONTRATANTE")).caminho);
    const segundoId = (await admin().cadastrarSegundo(executor(a), f.ctx, f.festaId, { nome: "Lia Segunda", whatsapp: "11999997777" }, pepper())).id;
    const ls = tokenDo((await admin().gerarLinkArea(executor(a), f.ctx, f.festaId, "SEGUNDO_RESPONSAVEL")).caminho);

    // Sequência do parecer: pedir o código, a equipe troca o WhatsApp, confirmar com o código antigo → recusa.
    const c1 = await pedirCodigo(f, lc, f.cpf);
    await a.query("UPDATE clientes SET whatsapp = '11988887777' WHERE id = $1::uuid", [f.clienteId]);
    assert.equal(await statusDa(c1.validacaoId), "CANCELADA");
    assert.deepEqual(await confirmar(f, c1.validacaoId, c1.codigo), { ok: false, motivo: "RECUSADO" });

    const s1 = await pedirCodigo(f, ls, null);
    await a.query("UPDATE festa_pessoas SET whatsapp = '11988886666' WHERE id = $1::uuid", [segundoId]);
    assert.equal(await statusDa(s1.validacaoId), "CANCELADA");
    assert.deepEqual(await confirmar(f, s1.validacaoId, s1.codigo), { ok: false, motivo: "RECUSADO" });

    // E-mail e documento do segundo também encerram o código pendente.
    const s2 = await pedirCodigo(f, ls, null);
    await a.query("UPDATE festa_pessoas SET email = 'lia@example.invalid' WHERE id = $1::uuid", [segundoId]);
    assert.equal(await statusDa(s2.validacaoId), "CANCELADA");
    await a.query("UPDATE validacoes_identidade_cliente SET criado_em = criado_em - interval '2 hours' WHERE festa_pessoa_id = $1::uuid", [segundoId]);
    const s3 = await pedirCodigo(f, ls, null);
    await a.query("UPDATE festa_pessoas SET documento_hash = $2 WHERE id = $1::uuid", [segundoId, "b".repeat(64)]);
    assert.equal(await statusDa(s3.validacaoId), "CANCELADA");
    await a.query("UPDATE festa_pessoas SET documento_hash = NULL WHERE id = $1::uuid", [segundoId]);

    // Defesa em profundidade: mesmo com os gatilhos desligados (validação continua PENDENTE), o código enviado ao número
    // antigo não confere com o WhatsApp atual. Com o número de volta, o mesmo código ainda vale.
    const c2 = await pedirCodigo(f, lc, f.cpf);
    await a.query("SET LOCAL session_replication_role = replica");
    await a.query("UPDATE clientes SET whatsapp = '11977776666' WHERE id = $1::uuid", [f.clienteId]);
    await a.query("SET LOCAL session_replication_role = origin");
    assert.equal(await statusDa(c2.validacaoId), "PENDENTE");
    assert.deepEqual(await confirmar(f, c2.validacaoId, c2.codigo), { ok: false, motivo: "CODIGO_INCORRETO" });
    await a.query("SET LOCAL session_replication_role = replica");
    await a.query("UPDATE clientes SET whatsapp = '11988887777' WHERE id = $1::uuid", [f.clienteId]);
    await a.query("SET LOCAL session_replication_role = origin");
    const ok = await confirmar(f, c2.validacaoId, c2.codigo);
    assert.equal(ok.ok, true, "mesmo número: o código confere");
  });
});

test("123 (AF-R1): troca de contato concorrente espera a emissão e a confirmação (duas conexões)", { skip: !opt(), timeout: 600_000 }, async (t) => {
  if (!com123) return t.skip("modelo sem a 123");
  // Precisa de dados COMMITADOS para a segunda conexão enxergar; o banco é descartável e recriado a cada rodada.
  const b = await conectarDescartavel({ travar: false });
  const obs = await conectarDescartavel({ travar: false });
  const restaurarAmbiente = ambienteAssinatura();
  const esperandoTrava = async () => {
    for (let i = 0; i < 100; i++) {
      const n = (await obs.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid = $1 AND state = 'active' AND wait_event_type = 'Lock'`, [pidA])).rows[0].n;
      if (n === 1) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  };
  const pidA = (await a.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
  try {
    let f: Festa;
    let link: string;
    await a.query("BEGIN");
    const restaurarPool = poolNaTransacao(a);
    try {
      f = await festa(150);
      link = tokenDo((await admin().gerarLinkArea(executor(a), f.ctx, f.festaId, "CONTRATANTE")).caminho);
      await a.query("COMMIT");
    } catch (e) { await a.query("ROLLBACK"); throw e; } finally { restaurarPool(); }

    // 1) Emissão em andamento (b) segura o cadastro: a troca (a) espera e, ao entrar, cancela o código recém-emitido.
    await b.query("BEGIN");
    const emitido = await pedirCodigo(f, link, f.cpf, b);
    await a.query("BEGIN");
    const troca1 = a.query("UPDATE clientes SET whatsapp = '11988887777' WHERE id = $1::uuid", [f.clienteId]);
    assert.equal(await esperandoTrava(), true, "a troca de contato espera a emissão");
    await b.query("COMMIT");
    await troca1;
    await a.query("COMMIT");
    assert.equal(await statusDa(emitido.validacaoId), "CANCELADA");
    // Os serviços rodam sempre dentro de transação (contrato do executor); a prova também (AF-R2-OBS1).
    await b.query("BEGIN");
    assert.deepEqual(await confirmar(f, emitido.validacaoId, emitido.codigo, b), { ok: false, motivo: "RECUSADO" });
    await b.query("COMMIT");

    // 2) Confirmação em andamento (b) segura a validação: a troca (a) espera e, ao entrar, derruba a sessão criada.
    await b.query("BEGIN");
    const novo = await pedirCodigo(f, link, f.cpf, b);
    await b.query("COMMIT");
    await b.query("BEGIN");
    const entrada = await confirmar(f, novo.validacaoId, novo.codigo, b) as { ok: true; token: string };
    assert.equal(entrada.ok, true);
    await a.query("BEGIN");
    const troca2 = a.query("UPDATE clientes SET whatsapp = '11977776666' WHERE id = $1::uuid", [f.clienteId]);
    assert.equal(await esperandoTrava(), true, "a troca de contato espera a confirmação");
    await b.query("COMMIT");
    await troca2;
    await a.query("COMMIT");
    assert.equal(await statusDa(novo.validacaoId), "CONSUMIDA");
    assert.equal(await acesso().lerSessao(executor(b), f.codigo, entrada.token), null, "sessão criada antes da troca cai com ela");
  } finally {
    restaurarAmbiente();
    for (const c of [b, obs]) { await c.query("ROLLBACK").catch(() => {}); await c.end(); }
    await a.query("ROLLBACK").catch(() => {});
  }
});

test("123 (AF-R2): CNPJ alfanumérico do contratante confere com as letras; sem letras ou com letras trocadas recusa", { skip: !opt(), timeout: 300_000 }, async (t) => {
  if (!com123) return t.skip("modelo sem a 123");
  await emTx(async () => {
    const f = await festa();
    await a.query(`UPDATE clientes SET tipo_pessoa = 'PJ', cpf = NULL, cnpj = '12ABC34501DE35', nome_completo = 'Empresa Sintética',
                   razao_social = 'Empresa Sintética', representante_nome = 'Pessoa Sintética' WHERE id = $1::uuid`, [f.clienteId]);
    const lc = tokenDo((await admin().gerarLinkArea(executor(a), f.ctx, f.festaId, "CONTRATANTE")).caminho);
    for (const errado of ["123450135", "12ACB34501DE35", "12ABC34501ED35", "12345678000190"]) {
      assert.deepEqual(await iniciar(f, lc, errado), { ok: false, motivo: "RECUSADO" }, errado);
    }
    const certo = await iniciar(f, lc, "12.abc.345/01de-35");
    assert.equal(certo.ok, true, "CNPJ certo, com máscara e minúsculas");
  });
});
