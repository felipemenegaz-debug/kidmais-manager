import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";
import {
  ambienteAssinatura, assinarComoCliente, carregar, catalogoNativo, catalogoNoTurno, cenario, completarCliente, congelarEAssinarKidmais, decisoes, dia, executor, id, importacao,
  integrar, PARCIAL, poolNaTransacao, validarAgora, type Cenario, type Servico, comSalaoEscolhido,
} from "../../scripts/integracao-importados-test-support.ts";

/**
 * Gate PG da agenda (conferência do Astra, 22/10/2026), no PostgreSQL DESCARTÁVEL com o inventário até a 094:
 * - P2-1: remarcação pelos SERVIÇOS reais (nova versão → editar festa → revalidarAgendaRevisao/hold → assinaturas Kidmais
 *   e cliente → aplicação) com capacidade POR_SALAO e COMMIT real, conferida por outra conexão: escolha de salão elegível
 *   (horário × pacote × livre), recusa sem salão elegível e o salão do destino aplicado à festa;
 * - P2-2: deduplicação origem × hold — a festa A com origem e hold sobrepostos conta UMA vez: capacidade 2 aceita B e
 *   recusa C; o mesmo com limite diário;
 * - P3: concorrência determinística — a segunda conexão fica comprovadamente esperando o lock da data antes de a
 *   primeira confirmar.
 */
let a: Client;
type Operar = Parameters<typeof congelarEAssinarKidmais>[1];
/**
 * Ressalva do Astra (aplicador da 100, 25/10/2026, P3): o inventário de pares da 100 com uma remarcação REAL (origem +
 * hold do destino pelos serviços). Só leitura; não depende da 100 aplicada. Medido por diferença (outras suítes/casos).
 */
const { SQL_INVENTARIO } = createRequire(import.meta.url)(join(resolve(dirname(fileURLToPath(import.meta.url)), "../.."), "scripts/migration-100-comum.cjs")) as { SQL_INVENTARIO: string };
const paresDoInventario = async () => (await a.query<{ pares_mesmo_horario: number }>(SQL_INVENTARIO)).rows[0].pares_mesmo_horario;

const ctxOp = () => ({ requestId: randomUUID(), ip: null, userAgent: "gate-094" });
const HORA = { inicio: "10:00", fim: "22:00" };

async function recusa(promessa: Promise<unknown>, trecho: RegExp) {
  await assert.rejects(promessa, (e: unknown) => trecho.test(e instanceof Error ? e.message : String(e)));
}

async function configurar(db: Client, c: Cenario, tipo: "POR_HORARIO" | "POR_SALAO", limite: number | null = null) {
  await db.query(`INSERT INTO agenda_escopo_config (empresa_id, modo, capacidade_tipo, limite_festas_dia, intervalo_minimo_minutos, configurado_por)
                  VALUES ($1::uuid, 'FIXO', $2, $3, 0, $4::uuid)`, [c.empresa, tipo, limite, c.usuario]);
}

/** Festa gravada e confirmada pelo caminho do banco (gatilhos da 019/062/094), sem contrato. */
async function inserirFesta(db: Client, c: Cenario, cfg: string, data: string, salao: string | null = null) {
  return id(db, `INSERT INTO fechamentos (data_evento, horario_inicio, horario_fim, configuracao_agenda_id, empresa_id, pacote_id, tabela_preco_id, preco_pacote_id,
        categoria_horario, categoria_preco_aplicada, convidados, convidados_faturados, valor_pacote_base, valor_pacote_aplicado, valor_tabela, origem_fechamento, cliente_id, status, salao_id)
      SELECT $1::date, $2::time, $3::time, $4::uuid, $5::uuid, p.id, pp.tabela_preco_id, pp.id, 'PADRAO', 'PADRAO', 10, 10, 100, 100, 100,
             'ATENDIMENTO_KIDMAIS', NULL, 'AGUARDANDO_CONTRATO', $7::uuid FROM pacotes p JOIN precos_pacote pp ON pp.pacote_id = p.id WHERE p.id = $6::uuid LIMIT 1 RETURNING fechamentos.id`,
    [data, HORA.inicio, HORA.fim, cfg, c.empresa, c.pacote, salao]);
}
const confirmar = (db: Client, f: string) => db.query(`UPDATE fechamentos SET status = 'CONFIRMADO' WHERE id = $1::uuid`, [f]);

/** Festa confirmada numa transação própria, com COMMIT real (as conferências adiadas rodam no COMMIT). */
async function confirmadaComCommit(db: Client, c: Cenario, cfg: string, data: string, salao: string | null = null) {
  await db.query("BEGIN");
  try {
    const f = await inserirFesta(db, c, cfg, data, salao);
    await confirmar(db, f);
    await db.query("COMMIT");
    return f;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
}

/** Modelo de contrato publicado da empresa (072): a assinatura nativa gera o PDF a partir dele. */
async function modeloContrato(c: Cenario) {
  const conteudo = {
    titulo: "Contrato de Festa Gate 094",
    contratada: { nome: "Buffet Gate 094 Ltda", documento: "11.222.333/0001-81", endereco: "Rua Teste, 94", representante: "Pessoa Teste" },
    preambulo: [], clausulas: [{ titulo: "Objeto", texto: "Festa em {{festa.data}} para {{contratante.nome}}." }], observacoes: [], cidadeAssinatura: "Cidade Teste",
  };
  await a.query(`INSERT INTO modelos_contrato_empresa (empresa_id, versao, conteudo, conteudo_sha256, aprovado_por) VALUES ($1::uuid, 1, $2::jsonb, $3, $4::uuid)`,
    [c.empresa, JSON.stringify(conteudo), "a".repeat(64), c.usuario]);
}

/** Contrato histórico integrado (festa confirmada, contrato assinado em papel) e a remarcação pelos serviços reais. */
async function contratada(c: Cenario, nativo: Awaited<ReturnType<typeof catalogoNativo>>, data: string) {
  const s = carregar<Servico>("lib/contratos/integracao-importados/servico.ts");
  const { coreNativo } = carregar<typeof import("../contratos/integracao-importados/composicao.ts")>("lib/contratos/integracao-importados/composicao.ts");
  const adm = carregar<typeof import("../contratos/services/administrativo.service.ts")>("lib/contratos/services/administrativo.service.ts");
  const rs = carregar<typeof import("../fechamentos/services/revisao-operacional.service.ts")>("lib/fechamentos/services/revisao-operacional.service.ts");
  const operar = adm.operarContrato as unknown as Operar;
  const ev = { data, ...HORA };
  const imp = await importacao(a, c, ev);
  const cpf = await completarCliente(a, imp.cliente);
  const r = await integrar(s, coreNativo, a, c, imp.id, await comSalaoEscolhido(s, a, c, imp.id, decisoes(c, ev, PARCIAL())));
  await validarAgora(a);
  const festa = (await a.query<{ id: string }>(`SELECT fechamento_id::text id FROM contratos WHERE id = $1`, [r.contratoId])).rows[0].id;
  const tx = executor(a);
  const abrir = async (motivo: string) => {
    const vigente = (await a.query<{ v: string }>(`SELECT versao_vigente_id::text v FROM contrato_fluxos WHERE contrato_id = $1`, [r.contratoId])).rows[0].v;
    await operar(vigente, { acao: "nova_versao", tipo: "NOVA_VERSAO", motivo, chaveCriacao: randomUUID() }, c.token, ctxOp(), c.empresa);
    const v2 = (await a.query<{ id: string }>(`SELECT versao_em_preparacao_id::text id FROM contrato_fluxos WHERE contrato_id = $1`, [r.contratoId])).rows[0].id;
    const editar = async (destino: string, tema = "Circo", configuracao = nativo.turno) => {
      const fonte = (await rs.fontesPreparacao(v2, tx))!;
      const revisao = (await a.query<{ revisao: number }>(`SELECT revisao FROM contrato_edicoes WHERE contrato_versao_id = $1`, [v2])).rows[0].revisao;
      return operar(v2, { acao: "editar_festa", revisao, motivo, fonteHash: fonte.fonteHash, pacoteId: c.pacote, convidados: 50,
        dataEvento: destino, configuracaoAgendaId: configuracao, horarioInicio: HORA.inicio, horarioFim: HORA.fim, adicionais: fonte.adicionais,
        idadeAniversarianteEvento: 6, temaFesta: tema, buffetStatus: "PENDENTE", buffetSalgados: "", buffetBebidas: "", buffetDoces: "", buffetBolo: "", buffetOutros: "",
        observacoesEquipe: "Gate 094" }, c.token, ctxOp(), c.empresa);
    };
    const concluir = async () => {
      await congelarEAssinarKidmais(a, operar, v2, c.empresa, c.token, nativo.tokenRepresentante);
      await assinarComoCliente(r.contratoId, cpf);
      await validarAgora(a);
    };
    const preparacao = async () => (await a.query<{ id: string; estado: string; salao: string | null; hold: string | null; data: string }>(
      `SELECT id::text, estado, salao_id::text salao, hold_destino_adquirido_em::text hold, data_evento::text data FROM fechamento_revisoes WHERE contrato_versao_id = $1`, [v2])).rows[0];
    return { v2, editar, concluir, preparacao };
  };
  return { festa, contrato: r.contratoId, abrir };
}

/**
 * Turno em que a importação gravou a festa. Com a empresa sem turno próprio, a importação escolhe entre os modelos
 * GLOBAIS que contêm 10:00 por ordem_exibicao e id (repositorio.configuracaoAgenda); todo `cenario` cria um global
 * idêntico (ordem 99), então, com cenários de outras suítes/casos já comitados, o escolhido pode ser o de outro cenário,
 * sem elegibilidade deste pacote (ELEGIBILIDADE_NAO_CONFIGURADA intermitente na remarcação). O produto está certo (os
 * globais reais, TURNO_1/TURNO_2, não empatam); o teste grava no turno escolhido o mesmo catálogo do turno do cenário.
 */
async function turnoDaFesta(c: Cenario, nativo: Awaited<ReturnType<typeof catalogoNativo>>, festa: string) {
  const turno = (await a.query<{ c: string }>(`SELECT configuracao_agenda_id::text c FROM fechamentos WHERE id = $1`, [festa])).rows[0].c;
  if (turno !== nativo.turno) await catalogoNoTurno(a, c, turno);
  return turno;
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

test.before(async () => {
  process.env.FESTA_ENABLED = "true";
  process.env.CONTRACT_IMPORT_INTEGRATION_ENABLED = "true";
  a = await conectarDescartavel();
});
test.after(async () => { if (a) await encerrarDescartavel(a); });

test("P2-1 POR_SALAO pelos serviços reais com COMMIT: salão elegível no destino, recusa sem salão elegível e salão aplicado à festa", { timeout: 300_000 }, async () => {
  const D1 = dia(70), D2 = dia(71);
  const r = await comCommit(async () => {
    const c = await cenario(a, 0);
    const nativo = await catalogoNativo(a, c);
    await modeloContrato(c);
    await configurar(a, c, "POR_SALAO");
    const salao = (nome: string, ordem: number) => id(a, `INSERT INTO agenda_saloes (empresa_id, nome, ordem, ativo) VALUES ($1::uuid, $2, $3, true) RETURNING id`, [c.empresa, nome, ordem]);
    // S0 vem primeiro na ordem, mas o pacote só permite S1 e S2: nunca é escolhido para esse pacote.
    const S0 = await salao("Salão 0", 1), S1 = await salao("Salão 1", 2), S2 = await salao("Salão 2", 3);
    for (const s of [S1, S2]) await a.query(`INSERT INTO pacote_saloes (pacote_id, salao_id) VALUES ($1::uuid, $2::uuid)`, [c.pacote, s]);
    // F: contratada em D1; a formalização escolhe o salão (S1: primeiro elegível e livre).
    const F = await contratada(c, nativo, D1);
    assert.equal((await a.query(`SELECT salao_id::text s FROM fechamentos WHERE id = $1`, [F.festa])).rows[0].s, S1, "formalização escolheu S1");
    // X ocupa S1 em D2, no mesmo horário.
    const X = await inserirFesta(a, c, nativo.turno, D2, S1);
    await confirmar(a, X);
    await validarAgora(a);
    // Remarcação de F para D2: S1 ocupado, S0 não permitido pelo pacote → S2, com hold.
    const rf = await F.abrir("Remarcação para D2");
    await rf.editar(D2);
    const pf = await rf.preparacao();
    assert.equal(pf.salao, S2, "destino com o salão elegível livre");
    assert.ok(pf.hold, "hold adquirido pelo serviço");
    await rf.concluir();
    // Y: contratada em D1 (S1, livre depois da saída de F); remarcar para D2 sem salão elegível livre é recusado.
    const Y = await contratada(c, nativo, D1);
    const ry = await Y.abrir("Remarcação de Y para D2");
    await recusa(ry.editar(D2), /Destino da revisão indisponível/);
    assert.equal((await ry.preparacao()).data, D1, "a preparação de Y segue no horário de origem");
    // Controle: com S0 liberado para o pacote, o mesmo destino passa (a recusa era pela elegibilidade).
    await a.query(`INSERT INTO pacote_saloes (pacote_id, salao_id) VALUES ($1::uuid, $2::uuid)`, [c.pacote, S0]);
    await ry.editar(D2);
    const py = await ry.preparacao();
    assert.equal(py.salao, S0);
    assert.ok(py.hold);
    await validarAgora(a);
    return { F: F.festa, X, Y: Y.festa, S0, S1, S2, revisaoF: pf.id, revisaoY: py.id };
  });
  // Conferência por OUTRA conexão, depois do COMMIT.
  const b = await conectarDescartavel({ travar: false });
  try {
    const f = (await b.query(`SELECT data_evento::text d, salao_id::text s, status FROM fechamentos WHERE id = $1`, [r.F])).rows[0];
    assert.deepEqual(f, { d: D2, s: r.S2, status: "CONFIRMADO" }, "festa F remarcada para D2 no salão S2");
    assert.equal((await b.query(`SELECT estado FROM fechamento_revisoes WHERE id = $1`, [r.revisaoF])).rows[0].estado, "APLICADA");
    const y = (await b.query(`SELECT estado, salao_id::text s, hold_destino_adquirido_em IS NOT NULL hold FROM fechamento_revisoes WHERE id = $1`, [r.revisaoY])).rows[0];
    assert.deepEqual(y, { estado: "EM_ELABORACAO", s: r.S0, hold: true });
    const ocupacoes = (await b.query(`SELECT fechamento_id::text f, salao_id::text s FROM kidmais094_ocupacoes($1::date, $1::date) WHERE fechamento_id = ANY($2::uuid[]) ORDER BY s`, [D2, [r.F, r.X, r.Y]])).rows;
    assert.deepEqual(new Set(ocupacoes.map((o) => `${o.f}:${o.s}`)), new Set([`${r.F}:${r.S2}`, `${r.X}:${r.S1}`, `${r.Y}:${r.S0}`]), "D2: X em S1, F em S2, hold de Y em S0");
  } finally {
    await encerrarDescartavel(b, false);
  }
});

test("P2-2 deduplicação origem × hold: A conta uma vez — capacidade 2 aceita B e recusa C; limite diário 2 idem", { timeout: 300_000 }, async () => {
  const cenarioComHold = async (dataA: string, ajuste: (c: Cenario, turno: string) => Promise<void>) => comCommit(async () => {
    const c = await cenario(a, 0);
    const nativo = await catalogoNativo(a, c);
    const A = await contratada(c, nativo, dataA);
    const cfgA = await turnoDaFesta(c, nativo, A.festa);
    await ajuste(c, cfgA);
    // Preparação aberta (o serviço adquire o hold no mesmo horário) e editada sem mudar o destino: origem e hold sobrepostos.
    const ra = await A.abrir("Correção de tema");
    await ra.editar(dataA, "Fundo do mar", cfgA);
    assert.ok((await ra.preparacao()).hold, "hold do destino adquirido");
    const ocup = (await a.query<{ n: number }>(`SELECT count(*)::int n FROM kidmais094_ocupacoes($1::date, $1::date) WHERE fechamento_id = $2::uuid`, [dataA, A.festa])).rows[0].n;
    assert.equal(ocup, 2, "A ocupa origem e hold (duas ocupações da mesma festa)");
    await validarAgora(a);
    const origemEHold = (await a.query<{ cfg: string }>(`SELECT DISTINCT configuracao_agenda_id::text cfg FROM kidmais094_ocupacoes($1::date, $1::date) WHERE fechamento_id = $2::uuid`, [dataA, A.festa])).rows;
    assert.deepEqual(origemEHold.map((o) => o.cfg), [cfgA], "origem e hold no mesmo horário configurado");
    return { c, turno: cfgA };
  });
  const b = await conectarDescartavel({ travar: false });
  try {
    // Capacidade 2 no horário.
    const D3 = dia(72);
    const antesDeA = await paresDoInventario();
    const h = await cenarioComHold(D3, async (c, turno) => {
      await configurar(a, c, "POR_HORARIO");
      await a.query(`UPDATE configuracao_agenda SET capacidade = 2 WHERE id = $1::uuid`, [turno]);
    });
    assert.equal(await paresDoInventario(), antesDeA, "inventário da 100: origem e hold da MESMA festa não formam par");
    await confirmadaComCommit(b, h.c, h.turno, D3);
    assert.equal(await paresDoInventario(), antesDeA + 1, "inventário da 100: B contra A (origem + hold) é UM par, sem duplicar");
    await recusa(confirmadaComCommit(b, h.c, h.turno, D3), /Conflito/);
    // Limite diário 2 (capacidade folgada no horário).
    const D4 = dia(73);
    const l = await cenarioComHold(D4, async (c, turno) => {
      await configurar(a, c, "POR_HORARIO", 2);
      await a.query(`UPDATE configuracao_agenda SET capacidade = 5 WHERE id = $1::uuid`, [turno]);
    });
    await confirmadaComCommit(b, l.c, l.turno, D4);
    await recusa(confirmadaComCommit(b, l.c, l.turno, D4), /Conflito/);
    // Inventário da 100 com conflito SÓ com o destino: A remarcada de D6 para D7 (hold em D7), B confirmada em D7.
    const D6 = dia(75), D7 = dia(76);
    const antesDoDestino = await paresDoInventario();
    const r = await comCommit(async () => {
      const c = await cenario(a, 0);
      const nativo = await catalogoNativo(a, c);
      const A = await contratada(c, nativo, D6);
      const cfgA = await turnoDaFesta(c, nativo, A.festa);
      // A remarcação para outra data vem ANTES da configuração por empresa (o horário do cenário é o global, que a agenda
      // configurada deixaria de oferecer para um destino novo); depois, um salão com capacidade 2 no horário.
      const ra = await A.abrir("Remarcação para outro dia");
      await ra.editar(D7, "Fundo do mar", cfgA);
      assert.ok((await ra.preparacao()).hold, "hold do destino adquirido em D7");
      await configurar(a, c, "POR_HORARIO");
      await a.query(`UPDATE configuracao_agenda SET capacidade = 2 WHERE id = $1::uuid`, [cfgA]);
      await validarAgora(a);
      const datas = (await a.query<{ d: string }>(`SELECT data::text d FROM kidmais094_ocupacoes($1::date, $2::date) WHERE fechamento_id = $3::uuid ORDER BY 1`, [D6, D7, A.festa])).rows;
      assert.deepEqual(datas.map((x) => x.d), [D6, D7], "origem em D6 e destino em D7");
      return { c, turno: cfgA };
    });
    assert.equal(await paresDoInventario(), antesDoDestino, "A sozinha (origem e destino em dias diferentes): nenhum par");
    await confirmadaComCommit(b, r.c, r.turno, D7);
    assert.equal(await paresDoInventario(), antesDoDestino + 1, "B em D7 conflita só com o DESTINO de A: um par");
    for (const [c, data] of [[h.c, D3], [l.c, D4]] as const) {
      assert.equal((await b.query(`SELECT count(*)::int n FROM fechamentos WHERE empresa_id = $1::uuid AND data_evento = $2::date AND status = 'CONFIRMADO'`, [c.empresa, data])).rows[0].n, 2, "A + B");
    }
  } finally {
    await encerrarDescartavel(b, false);
  }
});

test("P3 concorrência determinística: a segunda conexão espera o lock da data; ao liberar, a primeira vence e a segunda é recusada", { timeout: 120_000 }, async () => {
  const D5 = dia(74);
  const c = await cenario(a, 0);
  await configurar(a, c, "POR_HORARIO");
  const cfg = await id(a, `INSERT INTO configuracao_agenda (codigo, nome, horario_inicio_padrao, horario_fim_padrao, tolerancia_inicio_minutos, passo_inicio_minutos,
        ordem_exibicao, empresa_id, capacidade) VALUES ($1, $1, $2, $3, 0, 30, 1, $4::uuid, 1) RETURNING id`, [`CORRIDA${randomUUID().slice(0, 6)}`, HORA.inicio, HORA.fim, c.empresa]);
  const b = await conectarDescartavel({ travar: false });
  const d = await conectarDescartavel({ travar: false });
  const obs = await conectarDescartavel({ travar: false });
  const pid = async (db: Client) => (await db.query<{ p: number }>("SELECT pg_backend_pid() p")).rows[0].p;
  const esperandoLock = async (p: number) => {
    for (let i = 0; i < 200; i++) {
      if ((await obs.query<{ w: string | null }>("SELECT wait_event_type w FROM pg_stat_activity WHERE pid = $1", [p])).rows[0]?.w === "Lock") return;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.fail(`conexão ${p} não chegou a esperar lock`);
  };
  try {
    const pidD = await pid(d);
    await b.query("BEGIN");
    const fb = await inserirFesta(b, c, cfg, D5);
    await confirmar(b, fb);
    await d.query("BEGIN");
    // A segunda pede a mesma data enquanto a primeira ainda não confirmou (COMMIT): fica presa no lock da data.
    const segunda = (async () => { const fd = await inserirFesta(d, c, cfg, D5); await confirmar(d, fd); await d.query("COMMIT"); })()
      .then(() => "ok", async (e: Error) => { await d.query("ROLLBACK").catch(() => undefined); return e; });
    await esperandoLock(pidD);
    await b.query("COMMIT");
    const r = await segunda;
    assert.ok(r instanceof Error && /Conflito/.test(r.message), `a segunda foi recusada: ${r instanceof Error ? r.message : r}`);
    assert.equal((await obs.query(`SELECT count(*)::int n FROM fechamentos WHERE configuracao_agenda_id = $1::uuid AND status = 'CONFIRMADO'`, [cfg])).rows[0].n, 1);
  } finally {
    await b.query("ROLLBACK").catch(() => undefined);
    await encerrarDescartavel(b, false);
    await encerrarDescartavel(d, false);
    await encerrarDescartavel(obs, false);
  }
});
