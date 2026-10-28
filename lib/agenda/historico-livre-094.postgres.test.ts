import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";
import {
  ambienteAssinatura, assinarComoCliente, carregar, catalogoNativo, cenario, completarCliente, congelarEAssinarKidmais, cpfValido, decisoes, dia, executor, id,
  importacao, integrarLegadoV1, PARCIAL, poolNaTransacao, validarAgora, type Cenario, type Servico,
} from "../../scripts/integracao-importados-test-support.ts";

/**
 * Correções da validação no navegador (22–23/10/2026), no PostgreSQL DESCARTÁVEL com o inventário até a 094: festa
 * marcada num horário FIXO que a agenda deixou de oferecer (troca para o modo livre) abre a revisão mantendo o mesmo
 * horário — importada e NATIVA — e a ocupação segue a regra da 094 (salão, capacidade, limite do dia, bloqueio):
 * - salão da festa livre, outro salão ocupado no mesmo horário → aceita (antes: recusada pela regra exclusiva);
 * - festa sem salão: com vaga → escolhe o salão livre; sem vaga → recusa;
 * - limite do dia atingido → recusa (controle: com folga, aceita);
 * - bloqueio no intervalo → recusa.
 * Abertura pelos serviços reais (operarContrato nova_versao → iniciarPreparacao → revalidarAgendaRevisao → hold), COMMIT
 * real e conferência por outra conexão.
 */
let a: Client;
type Operar = Parameters<typeof congelarEAssinarKidmais>[1];
type Nativo = Awaited<ReturnType<typeof catalogoNativo>>;
const ctxOp = () => ({ requestId: randomUUID(), ip: null, userAgent: "historico-094" });
const INDISPONIVEL = /Destino da revisão indisponível/;

async function recusa(promessa: Promise<unknown>, trecho: RegExp) {
  await assert.rejects(promessa, (e: unknown) => trecho.test(e instanceof Error ? e.message : String(e)));
}

async function modeloContrato(c: Cenario) {
  const conteudo = { titulo: "Contrato (TESTE)", contratada: { nome: "Buffet Teste Ltda", documento: "11.222.333/0001-81", endereco: "Rua Teste, 1", representante: "Pessoa Teste" },
    preambulo: [], clausulas: [{ titulo: "Objeto", texto: "Festa em {{festa.data}} para {{contratante.nome}}." }], observacoes: [], cidadeAssinatura: "Cidade Teste" };
  await a.query(`INSERT INTO modelos_contrato_empresa (empresa_id, versao, conteudo, conteudo_sha256, aprovado_por) VALUES ($1::uuid, 1, $2::jsonb, $3, $4::uuid)`,
    [c.empresa, JSON.stringify(conteudo), "a".repeat(64), c.usuario]);
}

async function configurar(c: Cenario, modo: "FIXO" | "LIVRE", limite: number | null = null) {
  await a.query(`INSERT INTO agenda_escopo_config (empresa_id, modo, capacidade_tipo, limite_festas_dia, intervalo_minimo_minutos, configurado_por)
                 VALUES ($1::uuid, $2, 'POR_SALAO', $3, 0, $4::uuid)`, [c.empresa, modo, limite, c.usuario]);
}

/** Troca para o modo livre: o horário técnico da empresa passa a ser o único oferecido; o horário fixo antigo some. */
async function passarParaLivre(c: Cenario, limite?: number | null) {
  await a.query(`UPDATE agenda_escopo_config SET modo = 'LIVRE'${limite !== undefined ? ", limite_festas_dia = $2" : ""} WHERE empresa_id = $1::uuid`,
    limite !== undefined ? [c.empresa, limite] : [c.empresa]);
  return id(a, `INSERT INTO configuracao_agenda (codigo, nome, horario_inicio_padrao, horario_fim_padrao, tolerancia_inicio_minutos, passo_inicio_minutos,
                  ordem_exibicao, empresa_id, horario_livre) VALUES ($1, 'Horário livre', '00:00', '23:59', 0, 30, 1, $2::uuid, true) RETURNING id`,
    [`LIVRE${randomUUID().slice(0, 8)}`, c.empresa]);
}

const salao = (c: Cenario, nome: string, ordem: number) =>
  id(a, `INSERT INTO agenda_saloes (empresa_id, nome, ordem, ativo) VALUES ($1::uuid, $2, $3, true) RETURNING id`, [c.empresa, nome, ordem]);

/** Outra festa confirmada (sem contrato) num salão, no horário livre. */
async function ocupante(c: Cenario, cfg: string, data: string, inicio: string, fim: string, salaoId: string) {
  const f = await id(a, `INSERT INTO fechamentos (data_evento, horario_inicio, horario_fim, configuracao_agenda_id, empresa_id, pacote_id, tabela_preco_id, preco_pacote_id,
        categoria_horario, categoria_preco_aplicada, convidados, convidados_faturados, valor_pacote_base, valor_pacote_aplicado, valor_tabela, origem_fechamento, cliente_id, status, salao_id)
      SELECT $1::date, $2::time, $3::time, $4::uuid, $5::uuid, p.id, pp.tabela_preco_id, pp.id, 'PADRAO', 'PADRAO', 10, 10, 100, 100, 100,
             'ATENDIMENTO_KIDMAIS', NULL, 'AGUARDANDO_CONTRATO', $7::uuid FROM pacotes p JOIN precos_pacote pp ON pp.pacote_id = p.id WHERE p.id = $6::uuid LIMIT 1 RETURNING fechamentos.id`,
    [data, inicio, fim, cfg, c.empresa, c.pacote, salaoId]);
  await a.query(`UPDATE fechamentos SET status = 'CONFIRMADO' WHERE id = $1::uuid`, [f]);
  return f;
}

/** Festa importada e integrada (contrato em papel, festa confirmada). */
async function importada(c: Cenario, data: string) {
  const s = carregar<Servico>("lib/contratos/integracao-importados/servico.ts");
  const { coreNativo } = carregar<typeof import("../contratos/integracao-importados/composicao.ts")>("lib/contratos/integracao-importados/composicao.ts");
  const ev = { data, inicio: "10:00", fim: "14:00" };
  const imp = await importacao(a, c, ev);
  await completarCliente(a, imp.cliente);
  // Legado V1 (D2 da S-E restante): revisões sobre contrato importado ANTES da importação V3 (salão automático da 094).
  const r = await integrarLegadoV1(s, coreNativo, a, c, imp.id, decisoes(c, ev, PARCIAL()));
  await validarAgora(a);
  return r.contratoId as string;
}

/** Festa NATIVA: proposta no horário fixo do cenário → contrato → assinatura Kidmais → aceite do cliente (formaliza). */
async function nativa(c: Cenario, nativo: Nativo, data: string) {
  const cpf = cpfValido();
  const cliente = await id(a, `INSERT INTO clientes (nome_completo, empresa_id, cpf, email, telefone, whatsapp, cep, logradouro, numero, bairro, cidade, uf)
      VALUES ('Cliente nativo', $1::uuid, $2, $3, '11999998888', '11999998888', '01001000', 'Rua Sintética', '1', 'Centro', 'São Paulo', 'SP') RETURNING id`, [c.empresa, cpf, `${randomUUID()}@example.invalid`]);
  const aniversariante = await id(a, `INSERT INTO aniversariantes (cliente_id, nome) VALUES ($1::uuid, 'Aniversariante nativo') RETURNING id`, [cliente]);
  const proposta = await id(a, `INSERT INTO fechamentos (data_evento, horario_inicio, horario_fim, configuracao_agenda_id, empresa_id, pacote_id, tabela_preco_id, preco_pacote_id,
        categoria_horario, categoria_preco_aplicada, convidados, convidados_faturados, valor_pacote_base, valor_pacote_aplicado, valor_tabela, origem_fechamento, cliente_id, aniversariante_id, status)
      SELECT $1::date, '10:00', '14:00', $2::uuid, $3::uuid, p.id, pp.tabela_preco_id, pp.id, 'PADRAO', 'PADRAO', 10, 10, 100, 100, 100, 'ATENDIMENTO_KIDMAIS', $5::uuid, $6::uuid, 'AGUARDANDO_CONTRATO'
        FROM pacotes p JOIN precos_pacote pp ON pp.pacote_id = p.id WHERE p.id = $4::uuid LIMIT 1 RETURNING fechamentos.id`, [data, nativo.turno, c.empresa, c.pacote, cliente, aniversariante]);
  const contratos = carregar<typeof import("../contratos/services/contrato.service.ts")>("lib/contratos/services/contrato.service.ts");
  const gerado = await contratos.gerarContrato({ fechamentoId: proposta } as never, { usuarioId: c.usuario, origem: "SISTEMA", executor: executor(a) } as never) as { contrato: { id: string }; versao: { id: string } };
  const adm = carregar<typeof import("../contratos/services/administrativo.service.ts")>("lib/contratos/services/administrativo.service.ts");
  await congelarEAssinarKidmais(a, adm.operarContrato as unknown as Operar, gerado.versao.id, c.empresa, c.token, nativo.tokenRepresentante);
  await assinarComoCliente(gerado.contrato.id, cpf);
  await validarAgora(a);
  assert.equal((await a.query(`SELECT kidmais019_ocupa($1::uuid) o`, [proposta])).rows[0].o, true, "nativa formalizada ocupa");
  assert.equal((await a.query(`SELECT origem_fechamento o FROM fechamentos WHERE id = $1`, [proposta])).rows[0].o, "ATENDIMENTO_KIDMAIS");
  return gerado.contrato.id;
}

/** Abre a revisão (nova versão) pelo serviço real: a preparação revalida o destino atual e adquire o hold. */
async function abrirRevisao(c: Cenario, contratoId: string) {
  const adm = carregar<typeof import("../contratos/services/administrativo.service.ts")>("lib/contratos/services/administrativo.service.ts");
  const vigente = (await a.query<{ v: string }>(`SELECT versao_vigente_id::text v FROM contrato_fluxos WHERE contrato_id = $1`, [contratoId])).rows[0].v;
  await (adm.operarContrato as unknown as Operar)(vigente, { acao: "nova_versao", tipo: "NOVA_VERSAO", motivo: "Revisão depois do modo livre", chaveCriacao: randomUUID() }, c.token, ctxOp(), c.empresa);
  const v2 = (await a.query<{ id: string }>(`SELECT versao_em_preparacao_id::text id FROM contrato_fluxos WHERE contrato_id = $1`, [contratoId])).rows[0].id;
  return (await a.query<{ id: string; salao: string | null; hold: boolean }>(
    `SELECT id::text, salao_id::text salao, hold_destino_adquirido_em IS NOT NULL hold FROM fechamento_revisoes WHERE contrato_versao_id = $1`, [v2])).rows[0];
}

const festaDo = async (contratoId: string) => (await a.query<{ id: string; salao: string | null; cfg: string }>(
  `SELECT f.id::text, f.salao_id::text salao, f.configuracao_agenda_id::text cfg FROM contratos k JOIN fechamentos f ON f.id = k.fechamento_id WHERE k.id = $1`, [contratoId])).rows[0];

/** Cenário numa transação com os serviços nativos apontados para ela e COMMIT real no fim. */
async function comCommit<T>(corpo: (c: Cenario, nativo: Nativo) => Promise<T>) {
  await a.query("BEGIN");
  const restaurarPool = poolNaTransacao(a);
  const restaurarAmbiente = ambienteAssinatura();
  try {
    const c = await cenario(a, 0);
    const nativo = await catalogoNativo(a, c);
    await modeloContrato(c);
    const r = await corpo(c, nativo);
    await a.query("COMMIT");
    return r;
  } catch (error) {
    await a.query("ROLLBACK");
    throw error;
  } finally {
    restaurarAmbiente();
    restaurarPool();
  }
}

async function outraConexao<T>(trabalho: (b: Client) => Promise<T>) {
  const b = await conectarDescartavel({ travar: false });
  try { return await trabalho(b); } finally { await encerrarDescartavel(b, false); }
}

test.before(async () => {
  process.env.FESTA_ENABLED = "true";
  process.env.CONTRACT_IMPORT_INTEGRATION_ENABLED = "true";
  a = await conectarDescartavel();
});
test.after(async () => { if (a) await encerrarDescartavel(a); });

test("importada com salão: outra festa no OUTRO salão no mesmo horário não impede a revisão no horário antigo (COMMIT, outra conexão)", { timeout: 300_000 }, async () => {
  const D = dia(80);
  const r = await comCommit(async (c) => {
    await configurar(c, "FIXO");
    const S1 = await salao(c, "Salão 1", 1), S2 = await salao(c, "Salão 2", 2);
    const contrato = await importada(c, D);
    const f = await festaDo(contrato);
    assert.equal(f.salao, S1, "formalização escolheu S1");
    const livre = await passarParaLivre(c);
    await ocupante(c, livre, D, "11:00", "15:00", S2);
    await validarAgora(a);
    const prep = await abrirRevisao(c, contrato);
    assert.equal(prep.salao, S1, "mantém o salão da festa");
    assert.ok(prep.hold, "hold no horário antigo");
    await validarAgora(a);
    return { revisao: prep.id, S1, cfgAntigo: f.cfg };
  });
  await outraConexao(async (b) => {
    const p = (await b.query(`SELECT estado, salao_id::text s, hold_destino_adquirido_em IS NOT NULL h, configuracao_agenda_id::text cfg FROM fechamento_revisoes WHERE id = $1`, [r.revisao])).rows[0];
    assert.deepEqual(p, { estado: "EM_ELABORACAO", s: r.S1, h: true, cfg: r.cfgAntigo });
  });
});

test("importada sem salão: escolhe o salão elegível (pacote); sem salão elegível recusa", { timeout: 300_000 }, async () => {
  // No banco (094), festa sem salão em capacidade por salão bloqueia qualquer outra sobreposta (inclusive no intervalo):
  // "sem vaga" para ela vem da elegibilidade (pacote/horário), não de outra festa no mesmo horário.
  const D = dia(81);
  const r = await comCommit(async (c) => {
    const contrato = await importada(c, D);
    assert.equal((await festaDo(contrato)).salao, null, "formalizada antes da capacidade por salão");
    await configurar(c, "LIVRE");
    await salao(c, "Salão 1", 1);
    const S2 = await salao(c, "Salão 2", 2);
    await a.query(`INSERT INTO pacote_saloes (pacote_id, salao_id) VALUES ($1::uuid, $2::uuid)`, [c.pacote, S2]);
    await passarParaLivre(c);
    const prep = await abrirRevisao(c, contrato);
    assert.equal(prep.salao, S2, "S1 vem antes na ordem, mas o pacote só permite S2");
    assert.ok(prep.hold);
    await validarAgora(a);
    return { revisao: prep.id, S2 };
  });
  await outraConexao(async (b) => {
    assert.equal((await b.query(`SELECT salao_id::text s FROM fechamento_revisoes WHERE id = $1`, [r.revisao])).rows[0].s, r.S2);
  });
  await comCommit(async (c) => {
    const contrato = await importada(c, D);
    await configurar(c, "LIVRE");
    await salao(c, "Salão 1", 1);
    const S3 = await id(a, `INSERT INTO agenda_saloes (empresa_id, nome, ordem, ativo) VALUES ($1::uuid, 'Salão 3 (inativo)', 3, false) RETURNING id`, [c.empresa]);
    await a.query(`INSERT INTO pacote_saloes (pacote_id, salao_id) VALUES ($1::uuid, $2::uuid)`, [c.pacote, S3]);
    await passarParaLivre(c);
    await a.query("SAVEPOINT recusa");
    await recusa(abrirRevisao(c, contrato), INDISPONIVEL);
    await a.query("ROLLBACK TO SAVEPOINT recusa");
  });
});

test("limite do dia recusa a revisão no horário antigo (com folga, aceita); bloqueio sobre a reserva vigente é recusado pelo banco", { timeout: 300_000 }, async () => {
  const D = dia(82);
  // Duas outras festas no dia (sem sobreposição, fora do intervalo) com limite folgado; depois o limite cai para 2 (a
  // configuração muda, as festas ficam): a revisão de F no mesmo horário é recusada; com limite 3, aceita.
  await comCommit(async (c) => {
    await configurar(c, "FIXO");
    const S1 = await salao(c, "Salão 1", 1), S2 = await salao(c, "Salão 2", 2);
    const contrato = await importada(c, D);
    assert.equal((await festaDo(contrato)).salao, S1);
    const livre = await passarParaLivre(c);
    await ocupante(c, livre, D, "16:00", "18:00", S1);
    await ocupante(c, livre, D, "18:30", "20:30", S2);
    await validarAgora(a);
    await a.query(`UPDATE agenda_escopo_config SET limite_festas_dia = 2 WHERE empresa_id = $1::uuid`, [c.empresa]);
    await a.query("SAVEPOINT limite");
    await recusa(abrirRevisao(c, contrato), INDISPONIVEL);
    await a.query("ROLLBACK TO SAVEPOINT limite");
    await a.query(`UPDATE agenda_escopo_config SET limite_festas_dia = 3 WHERE empresa_id = $1::uuid`, [c.empresa]);
    const prep = await abrirRevisao(c, contrato);
    assert.ok(prep.hold, "com folga no limite, aceita");
    await validarAgora(a);
  });
  // Bloqueio: o banco não deixa criar bloqueio sobre a reserva vigente (kidmais_proteger_bloqueio_revisao), então manter
  // o horário exato nunca encontra bloqueio; a conferência de bloqueio do código fica como defesa (teste unitário).
  await comCommit(async (c) => {
    await configurar(c, "FIXO");
    await salao(c, "Salão 1", 1);
    const contrato = await importada(c, D);
    await passarParaLivre(c);
    await a.query("SAVEPOINT bloqueio");
    await recusa(a.query(`INSERT INTO bloqueios_agenda (data, dia_inteiro, horario_inicio, horario_fim, motivo, empresa_id) VALUES ($1::date, false, '12:00', '13:00', 'Manutenção', $2::uuid)`, [D, c.empresa]),
      /Bloqueio conflita com contratação vigente/);
    await a.query("ROLLBACK TO SAVEPOINT bloqueio");
    // Bloqueio fora do intervalo da festa: permitido, e a revisão no horário antigo continua aceita.
    await a.query(`INSERT INTO bloqueios_agenda (data, dia_inteiro, horario_inicio, horario_fim, motivo, empresa_id) VALUES ($1::date, false, '18:00', '19:00', 'Manutenção', $2::uuid)`, [D, c.empresa]);
    const prep = await abrirRevisao(c, contrato);
    assert.ok(prep.hold);
    await validarAgora(a);
  });
});

test("NATIVA no horário fixo que deixou de ser oferecido: abre a revisão mantendo o horário; outro salão ocupado não impede (COMMIT, outra conexão)", { timeout: 300_000 }, async () => {
  const D = dia(83);
  const r = await comCommit(async (c, nativo) => {
    await configurar(c, "FIXO");
    const S1 = await salao(c, "Salão 1", 1), S2 = await salao(c, "Salão 2", 2);
    const contrato = await nativa(c, nativo, D);
    const f = await festaDo(contrato);
    assert.equal(f.salao, S1);
    assert.equal(f.cfg, nativo.turno);
    const livre = await passarParaLivre(c);
    await ocupante(c, livre, D, "11:00", "15:00", S2);
    await validarAgora(a);
    const prep = await abrirRevisao(c, contrato);
    assert.equal(prep.salao, S1);
    assert.ok(prep.hold);
    await validarAgora(a);
    return { revisao: prep.id, S1, turno: nativo.turno };
  });
  await outraConexao(async (b) => {
    const p = (await b.query(`SELECT estado, salao_id::text s, hold_destino_adquirido_em IS NOT NULL h, configuracao_agenda_id::text cfg FROM fechamento_revisoes WHERE id = $1`, [r.revisao])).rows[0];
    assert.deepEqual(p, { estado: "EM_ELABORACAO", s: r.S1, h: true, cfg: r.turno });
  });
});

test("NATIVA com o horário fixo ainda oferecido (sem troca de modo) e fora dos candidatos: segue a regra nativa e recusa", { timeout: 300_000 }, async () => {
  const D = dia(84);
  await comCommit(async (c, nativo) => {
    await configurar(c, "FIXO");
    await salao(c, "Salão 1", 1);
    const contrato = await nativa(c, nativo, D);
    // O turno do cenário só oferece 10:00–22:00 (sem tolerância): 10:00–14:00 não é candidato e o horário segue oferecido.
    await a.query("SAVEPOINT nativa");
    await recusa(abrirRevisao(c, contrato), INDISPONIVEL);
    await a.query("ROLLBACK TO SAVEPOINT nativa");
  });
});
