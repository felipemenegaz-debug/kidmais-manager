import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";
import {
  ambienteAssinatura, carregar, catalogoNativo, catalogoNoTurno, cenario, completarCliente, congelarEAssinarKidmais, decisoes, dia, executor, id, importacao, integrar, PARCIAL,
  poolNaTransacao, validarAgora, type Cenario, type Servico, comSalaoEscolhido,
} from "../../scripts/integracao-importados-test-support.ts";

/**
 * B-13, revisão do Astra (31/10/2026, P3-2): remarcação pelos SERVIÇOS reais sob a regra da 100, com COMMIT real e
 * conferência por OUTRA conexão, nos modelos com o corpo da 100 (b14-P11 e b14-P10 = schema final de production; a 108,
 * presente nos modelos 108/109 e em staging, troca a regra de conflito e fica fora deste corpo):
 * - origem + hold da mesma festa contam UMA festa no limite diário, observado por outra festa (limite 2: B entra, C não);
 * - hold adquirido pelo serviço (editar festa → revalidarAgendaRevisao) ocupa o destino; cancelado pelo serviço
 *   (cancelar_revisao), libera — a mesma festa que era recusada passa a entrar.
 * Os auxiliares seguem remarcacao-salao-094.postgres.test.ts (mesmo caminho de serviços). No limite diário, a festa fica
 * em 10h–14h para caberem outras no mesmo dia (edição no próprio horário histórico); na troca de data, o destino precisa
 * ser um horário oferecido pela agenda — o turno inteiro do cenário (10h–22h), como na suíte da 094.
 */
let a: Client;
type Operar = Parameters<typeof congelarEAssinarKidmais>[1];
const H100 = "805cd427a7cc7a725fb3bdfb4fd050f04e618131104fcfc0678a0ddadd5b4bdb";
const ASSINATURA = "kidmais094_conflito_ocupacao(uuid,date,time without time zone,time without time zone,uuid,uuid,uuid,uuid)";
const ctxOp = () => ({ requestId: randomUUID(), ip: null, userAgent: "b13-100" });
const MANHA = { inicio: "10:00", fim: "14:00" };
const TURNO = { inicio: "10:00", fim: "22:00" };

async function recusa(promessa: Promise<unknown>, trecho: RegExp) {
  await assert.rejects(promessa, (e: unknown) => trecho.test(e instanceof Error ? e.message : String(e)));
}

async function configurar(c: Cenario, limite: number | null) {
  await a.query(`INSERT INTO agenda_escopo_config (empresa_id, modo, capacidade_tipo, limite_festas_dia, intervalo_minimo_minutos, configurado_por)
                 VALUES ($1::uuid, 'FIXO', 'POR_HORARIO', $2, 0, $3::uuid)`, [c.empresa, limite, c.usuario]);
}

async function horario(c: Cenario, codigo: string, inicio: string, fim: string) {
  return id(a, `INSERT INTO configuracao_agenda (codigo, nome, horario_inicio_padrao, horario_fim_padrao, tolerancia_inicio_minutos, passo_inicio_minutos,
                ordem_exibicao, empresa_id, capacidade) VALUES ($1, $1, $2, $3, 0, 30, 1, $4::uuid, 2) RETURNING id`, [codigo, inicio, fim, c.empresa]);
}

/** Festa confirmada por OUTRA conexão, numa transação própria com COMMIT real (as conferências adiadas rodam no COMMIT). */
async function festaComCommit(db: Client, c: Cenario, cfg: string, data: string, inicio: string, fim: string) {
  await db.query("BEGIN");
  try {
    const f = await id(db, `INSERT INTO fechamentos (data_evento, horario_inicio, horario_fim, configuracao_agenda_id, empresa_id, pacote_id, tabela_preco_id, preco_pacote_id,
          categoria_horario, categoria_preco_aplicada, convidados, convidados_faturados, valor_pacote_base, valor_pacote_aplicado, valor_tabela, origem_fechamento, cliente_id, status)
        SELECT $1::date, $2::time, $3::time, $4::uuid, $5::uuid, p.id, pp.tabela_preco_id, pp.id, 'PADRAO', 'PADRAO', 10, 10, 100, 100, 100,
               'ATENDIMENTO_KIDMAIS', NULL, 'AGUARDANDO_CONTRATO' FROM pacotes p JOIN precos_pacote pp ON pp.pacote_id = p.id WHERE p.id = $6::uuid LIMIT 1 RETURNING fechamentos.id`,
      [data, inicio, fim, cfg, c.empresa, c.pacote]);
    await db.query(`UPDATE fechamentos SET status = 'CONFIRMADO' WHERE id = $1::uuid`, [f]);
    await db.query("COMMIT");
    return f;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
}

/** Executa o cenário numa transação com os serviços nativos apontados para ela e COMMIT real no fim. */
async function comCommit<T>(corpo: () => Promise<T>) {
  await a.query("BEGIN");
  const restaurarPool = poolNaTransacao(a);
  const restaurarAmbiente = ambienteAssinatura();
  try {
    const r = await corpo();
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

/** Contrato histórico integrado (festa confirmada) e a remarcação pelos serviços reais: abrir, editar e cancelar. */
async function contratada(c: Cenario, nativo: Awaited<ReturnType<typeof catalogoNativo>>, data: string, hora: { inicio: string; fim: string }) {
  const s = carregar<Servico>("lib/contratos/integracao-importados/servico.ts");
  const { coreNativo } = carregar<typeof import("../contratos/integracao-importados/composicao.ts")>("lib/contratos/integracao-importados/composicao.ts");
  const adm = carregar<typeof import("../contratos/services/administrativo.service.ts")>("lib/contratos/services/administrativo.service.ts");
  const rs = carregar<typeof import("../fechamentos/services/revisao-operacional.service.ts")>("lib/fechamentos/services/revisao-operacional.service.ts");
  const operar = adm.operarContrato as unknown as Operar;
  const ev = { data, ...hora };
  const imp = await importacao(a, c, ev);
  await completarCliente(a, imp.cliente);
  const r = await integrar(s, coreNativo, a, c, imp.id, await comSalaoEscolhido(s, a, c, imp.id, decisoes(c, ev, PARCIAL())));
  await validarAgora(a);
  const festa = (await a.query<{ id: string }>(`SELECT fechamento_id::text id FROM contratos WHERE id = $1`, [r.contratoId])).rows[0].id;
  const tx = executor(a);
  const abrir = async (motivo: string) => {
    const vigente = (await a.query<{ v: string }>(`SELECT versao_vigente_id::text v FROM contrato_fluxos WHERE contrato_id = $1`, [r.contratoId])).rows[0].v;
    await operar(vigente, { acao: "nova_versao", tipo: "NOVA_VERSAO", motivo, chaveCriacao: randomUUID() }, c.token, ctxOp(), c.empresa);
    const v2 = (await a.query<{ id: string }>(`SELECT versao_em_preparacao_id::text id FROM contrato_fluxos WHERE contrato_id = $1`, [r.contratoId])).rows[0].id;
    const edicao = async () => (await a.query<{ revisao: number }>(`SELECT revisao FROM contrato_edicoes WHERE contrato_versao_id = $1`, [v2])).rows[0].revisao;
    const editar = async (destino: string, tema: string, configuracao: string) => {
      const fonte = (await rs.fontesPreparacao(v2, tx))!;
      return operar(v2, { acao: "editar_festa", revisao: await edicao(), motivo, fonteHash: fonte.fonteHash, pacoteId: c.pacote, convidados: 50,
        dataEvento: destino, configuracaoAgendaId: configuracao, horarioInicio: hora.inicio, horarioFim: hora.fim, adicionais: fonte.adicionais,
        idadeAniversarianteEvento: 6, temaFesta: tema, buffetStatus: "PENDENTE", buffetSalgados: "", buffetBebidas: "", buffetDoces: "", buffetBolo: "", buffetOutros: "",
        observacoesEquipe: "B-13" }, c.token, ctxOp(), c.empresa);
    };
    const cancelar = async () => operar(v2, { acao: "cancelar_revisao", revisao: await edicao(), motivo: "Desistiu da remarcação" }, c.token, ctxOp(), c.empresa);
    const preparacao = async () => (await a.query<{ id: string; estado: string; hold: string | null }>(
      `SELECT id::text, estado, hold_destino_adquirido_em::text hold FROM fechamento_revisoes WHERE contrato_versao_id = $1`, [v2])).rows[0];
    return { editar, cancelar, preparacao };
  };
  return { festa, abrir };
}

/** Turno da festa importada; grava nele o catálogo do cenário (ver turnoDaFesta em remarcacao-salao-094.postgres.test.ts). */
async function turnoDaFesta(c: Cenario, nativo: Awaited<ReturnType<typeof catalogoNativo>>, festa: string) {
  const turno = (await a.query<{ c: string }>(`SELECT configuracao_agenda_id::text c FROM fechamentos WHERE id = $1`, [festa])).rows[0].c;
  if (turno !== nativo.turno) await catalogoNoTurno(a, c, turno);
  return turno;
}

test.before(async () => {
  process.env.FESTA_ENABLED = "true";
  process.env.CONTRACT_IMPORT_INTEGRATION_ENABLED = "true";
  a = await conectarDescartavel();
});
test.after(async () => { if (a) await encerrarDescartavel(a); });

test("B-13 (100): o modelo tem a regra da 100", async () => {
  const h = (await a.query<{ h: string }>(`SELECT encode(sha256(convert_to(replace(prosrc, E'\\r', ''), 'UTF8')), 'hex') AS h FROM pg_proc
    WHERE oid = to_regprocedure('public.${ASSINATURA}')`)).rows[0]?.h;
  assert.equal(h, H100);
});

test("B-13 (100): origem + hold da mesma festa contam UMA festa no limite diário — outra festa entra, a terceira não (serviços, COMMIT, outra conexão)", { timeout: 300_000 }, async () => {
  const D = dia(80);
  const h = await comCommit(async () => {
    const c = await cenario(a, 0);
    const nativo = await catalogoNativo(a, c);
    const A = await contratada(c, nativo, D, MANHA);
    const cfgA = await turnoDaFesta(c, nativo, A.festa);
    await configurar(c, 2);
    const cfgB = await horario(c, `B13S_B_${randomUUID().slice(0, 6)}`, "15:00", "19:00");
    const cfgC = await horario(c, `B13S_C_${randomUUID().slice(0, 6)}`, "19:30", "21:30");
    // Preparação aberta e editada sem mudar data nem horário: o serviço adquire o hold sobre a própria origem.
    const ra = await A.abrir("Correção de tema");
    await ra.editar(D, "Fundo do mar", cfgA);
    assert.ok((await ra.preparacao()).hold, "hold do destino adquirido pelo serviço");
    const ocup = (await a.query<{ n: number }>(`SELECT count(*)::int n FROM kidmais094_ocupacoes($1::date, $1::date) WHERE fechamento_id = $2::uuid`, [D, A.festa])).rows[0].n;
    assert.equal(ocup, 2, "A ocupa origem e hold (duas ocupações da mesma festa)");
    await validarAgora(a);
    return { c, cfgB, cfgC, A: A.festa };
  });
  const b = await conectarDescartavel({ travar: false });
  try {
    // Limite 2: A conta uma vez, então B (outro horário, sem sobreposição) entra...
    await festaComCommit(b, h.c, h.cfgB, D, "15:00", "19:00");
    // ...e C, a terceira festa do dia, é recusada pelo limite.
    await recusa(festaComCommit(b, h.c, h.cfgC, D, "19:30", "21:30"), /Conflito/);
    const n = (await b.query(`SELECT count(*)::int n FROM fechamentos WHERE empresa_id = $1::uuid AND data_evento = $2::date AND status = 'CONFIRMADO'`, [h.c.empresa, D])).rows[0].n;
    assert.equal(n, 2, "A + B confirmadas, vistas por outra conexão");
  } finally {
    await encerrarDescartavel(b, false);
  }
});

test("B-13 (100): hold adquirido pelo serviço ocupa o destino; cancelado pelo serviço, libera (COMMIT, outra conexão)", { timeout: 300_000 }, async () => {
  const D6 = dia(82), D7 = dia(83);
  const r = await comCommit(async () => {
    const c = await cenario(a, 0);
    const nativo = await catalogoNativo(a, c);
    const A = await contratada(c, nativo, D6, TURNO);
    const cfgA = await turnoDaFesta(c, nativo, A.festa);
    // A remarcação para outra data vem ANTES da configuração por empresa (como em remarcacao-salao-094).
    const ra = await A.abrir("Remarcação para outro dia");
    await ra.editar(D7, "Fundo do mar", cfgA);
    const p = await ra.preparacao();
    assert.ok(p.hold, "hold do destino adquirido em D7");
    await configurar(c, null);
    await validarAgora(a);
    return { c, cfgA, ra, revisao: p.id, festa: A.festa };
  });
  const b = await conectarDescartavel({ travar: false });
  try {
    const noDestino = (await b.query(`SELECT fechamento_id::text f, origem FROM kidmais094_ocupacoes($1::date, $1::date) WHERE fechamento_id = $2::uuid`, [D7, r.festa])).rows;
    assert.deepEqual(noDestino, [{ f: r.festa, origem: "REVISAO_DESTINO" }], "outra conexão vê o hold de A em D7");
    // O hold ocupa: outra festa no mesmo horário do destino é recusada.
    await recusa(festaComCommit(b, r.c, r.cfgA, D7, TURNO.inicio, TURNO.fim), /Conflito/);
    // Cancelamento pelo serviço, com COMMIT: o hold sai.
    await comCommit(async () => { await r.ra.cancelar(); });
    assert.equal((await b.query(`SELECT estado FROM fechamento_revisoes WHERE id = $1`, [r.revisao])).rows[0].estado, "CANCELADA");
    assert.equal((await b.query(`SELECT count(*)::int n FROM kidmais094_ocupacoes($1::date, $1::date) WHERE fechamento_id = $2::uuid`, [D7, r.festa])).rows[0].n, 0, "hold liberado");
    // A mesma festa que era recusada agora entra (controle: a recusa era o hold).
    await festaComCommit(b, r.c, r.cfgA, D7, TURNO.inicio, TURNO.fim);
  } finally {
    await encerrarDescartavel(b, false);
  }
});
