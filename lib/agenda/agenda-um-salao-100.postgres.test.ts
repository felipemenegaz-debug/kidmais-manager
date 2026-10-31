import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";
import type { DbExecutor } from "../db/contracts.ts";
import { estruturaFesta019Sql } from "../festas/estrutura-019.ts";
import { carregar, cenario, comSalaoEscolhido, decisoes, dia, id, importacao, integrar, representante, type Cenario, type Evento, type Servico } from "../../scripts/integracao-importados-test-support.ts";
import { consultarDisponibilidadeData } from "../disponibilidade/services/availability.service.ts";

/**
 * 100 no PostgreSQL DESCARTÁVEL (modelo 097 = staging de hoje: 093–097 sem a 098; e modelo 098 para a recusa).
 * Decisão de Felipe (25/10/2026) e parecer do Astra (P1): com um salão (POR_HORARIO), a regra central do banco aceita
 * uma festa por vez no horário mesmo que a linha guarde capacidade maior; por salão, limite do dia, horários diferentes
 * e empresa sem configuração ficam como na 094. Rollback volta o corpo da 094; a 098 recusa por cima da 100.
 * B-13 (P3-T2 do parecer delta 4 da #234): provas dirigidas sob o corpo da 100, com controles válidos — hold real de
 * remarcação, configuração distinta × intervalo × capacidade gravada, e unidades distintas × limite do dia.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const arquivo = (p: string) => readFileSync(resolve(root, p), "utf8");
const MIGRATION = "database/migrations/20261025_100_agenda_um_salao.sql";
const ROLLBACK = "database/rollback/20261025_100_agenda_um_salao_down.sql";
const INTEGRIDADE = "database/checks/20261025_100_integridade.sql";
const PRECHECK = "database/checks/20261025_100_precheck.sql";
const POSTCHECK = "database/checks/20261025_100_postcheck.sql";
const ASSINATURA = "kidmais094_conflito_ocupacao(uuid,date,time without time zone,time without time zone,uuid,uuid,uuid,uuid)";
const H094 = "b6aac1c0b99ed64f4dca94fe5d886e5d5892b82888325010e02adc850def8cf6";
const H100 = "805cd427a7cc7a725fb3bdfb4fd050f04e618131104fcfc0678a0ddadd5b4bdb";
let a: Client;
let tx: DbExecutor;
let com098 = false;
type Revisao = typeof import("../fechamentos/repositories/revisao.repository.ts");
const D = dia(45);

async function recusa(promessa: Promise<unknown>, trecho: RegExp) {
  await assert.rejects(promessa, (e: unknown) => trecho.test(e instanceof Error ? e.message : String(e)));
  await a.query("ROLLBACK").catch(() => undefined);
}

/** Recusa dentro de uma transação aberta (savepoint do chamador): não encerra a transação. */
async function recusaSemRollback(promessa: Promise<unknown>, trecho: RegExp) {
  await assert.rejects(promessa, (e: unknown) => trecho.test(e instanceof Error ? e.message : String(e)));
}

const hashAtual = async () => (await a.query<{ h: string }>(
  `SELECT encode(sha256(convert_to(replace(prosrc, E'\\r', ''), 'UTF8')), 'hex') AS h FROM pg_proc WHERE oid = to_regprocedure('public.${ASSINATURA}')`)).rows[0]?.h;

async function horario(c: Cenario, codigo: string, inicio: string, fim: string, capacidade = 1, unidade: string | null = null) {
  return id(a, `INSERT INTO configuracao_agenda (codigo, nome, horario_inicio_padrao, horario_fim_padrao, tolerancia_inicio_minutos, passo_inicio_minutos,
                ordem_exibicao, empresa_id, capacidade, estabelecimento_id) VALUES ($1, $1, $2, $3, 0, 30, 1, $4::uuid, $5, $6::uuid) RETURNING id`,
    [codigo, inicio, fim, c.empresa, capacidade, unidade]);
}

async function configurar(c: Cenario, tipo: "POR_HORARIO" | "POR_SALAO", limite: number | null, intervalo: number, unidade: string | null = null) {
  await a.query(`INSERT INTO agenda_escopo_config (empresa_id, estabelecimento_id, modo, capacidade_tipo, limite_festas_dia, intervalo_minimo_minutos, configurado_por)
                 VALUES ($1::uuid, $6::uuid, 'FIXO', $2, $3, $4, $5::uuid)`, [c.empresa, tipo, limite, intervalo, c.usuario, unidade]);
}

/** Unidade agendável (062): habilitação vigente por Representante autorizado (como agenda-versao.postgres.test.ts). */
async function habilitar(c: Cenario, unidade: string) {
  const rep = await representante(a, c);
  await a.query(`INSERT INTO agenda_062_unidades_habilitacao (empresa_id, estabelecimento_id, habilitada_por, habilitada_papel, motivo_habilitacao)
                 VALUES ($1::uuid, $2::uuid, $3::uuid, 'REPRESENTANTE_AUTORIZADO', 'Provas B-13')`, [c.empresa, unidade, rep.usuarioId]);
}

/** Festa gravada e confirmada numa transação: os gatilhos diferidos conferem a agenda no COMMIT. */
async function confirmada(c: Cenario, cfg: string, inicio: string, fim: string, salao: string | null = null, unidade: string | null = null, data = D) {
  await a.query("BEGIN");
  try {
    const f = await id(a, `INSERT INTO fechamentos (data_evento, horario_inicio, horario_fim, configuracao_agenda_id, empresa_id, pacote_id, tabela_preco_id, preco_pacote_id,
          categoria_horario, categoria_preco_aplicada, convidados, convidados_faturados, valor_pacote_base, valor_pacote_aplicado, valor_tabela, origem_fechamento, cliente_id, status, salao_id,
          estabelecimento_id)
        SELECT $1::date, $2::time, $3::time, $4::uuid, $5::uuid, p.id, pp.tabela_preco_id, pp.id, 'PADRAO', 'PADRAO', 10, 10, 100, 100, 100,
               'ATENDIMENTO_KIDMAIS', NULL, 'AGUARDANDO_CONTRATO', $7::uuid, $8::uuid FROM pacotes p JOIN precos_pacote pp ON pp.pacote_id = p.id WHERE p.id = $6::uuid RETURNING fechamentos.id`,
      [data, inicio, fim, cfg, c.empresa, c.pacote, salao, unidade]);
    await a.query(`UPDATE fechamentos SET status = 'CONFIRMADO' WHERE id = $1::uuid`, [f]);
    await a.query("COMMIT");
    return f;
  } catch (error) {
    await a.query("ROLLBACK");
    throw error;
  }
}

/**
 * Festa integrada pelo caminho real (importação conferida → contrato assinado, festa confirmada) e a remarcação em
 * preparação (versão 2 + revisão operacional), como duracao-hold-094.postgres.test.ts. Chamar DENTRO da transação do teste.
 */
async function integradaComRevisao(c: Cenario, ev: Evento, unidade: string | null = null) {
  const s = carregar<Servico>("lib/contratos/integracao-importados/servico.ts");
  const { coreNativo } = carregar<typeof import("../contratos/integracao-importados/composicao.ts")>("lib/contratos/integracao-importados/composicao.ts");
  const impId = (await importacao(a, c, ev)).id;
  const r = await integrar(s, coreNativo, a, c, impId, await comSalaoEscolhido(s, a, c, impId, decisoes(c, ev, { situacao: "NAO_CONFERIDO" }, unidade)));
  const reserva = (await a.query(`SELECT f.id, f.configuracao_agenda_id cfg, v.id versao, v.snapshot, v.snapshot_hash FROM contratos k JOIN fechamentos f ON f.id = k.fechamento_id
      JOIN contrato_versoes v ON v.contrato_id = k.id WHERE k.id = $1`, [r.contratoId])).rows[0];
  const v2 = await id(a, `INSERT INTO contrato_versoes (contrato_id, numero_versao, status, snapshot, snapshot_hash, motivo_nova_versao)
      VALUES ($1::uuid, 2, 'ATIVA', $2::jsonb, $3, 'Remarcação B-13') RETURNING id`, [r.contratoId, JSON.stringify(reserva.snapshot), reserva.snapshot_hash]);
  await a.query(`UPDATE contrato_fluxos SET versao_em_preparacao_id = $2::uuid WHERE contrato_id = $1::uuid`, [r.contratoId, v2]);
  const { criarRevisaoOperacionalRegistro } = carregar<Revisao>("lib/fechamentos/repositories/revisao.repository.ts");
  const revisao = randomUUID();
  await criarRevisaoOperacionalRegistro(tx, { id: revisao, fechamentoId: reserva.id, contratoId: r.contratoId, versaoId: v2, baseId: reserva.versao,
    baseHash: reserva.snapshot_hash, motivo: "Remarcação", chave: randomUUID(), usuarioId: c.usuario });
  return { festa: reserva.id as string, cfg: reserva.cfg as string, revisao };
}

test.before(async () => {
  // Como as suítes 062/094: módulo Festa e integração de importados ligados só neste processo de teste.
  process.env.FESTA_ENABLED = "true";
  process.env.CONTRACT_IMPORT_INTEGRATION_ENABLED = "true";
  a = await conectarDescartavel();
  tx = { async query<Row extends object>(text: string, values?: readonly unknown[]) { const r = await a.query(text, values as unknown[]); return { rows: r.rows as Row[], rowCount: r.rowCount }; } };
  com098 = Boolean((await a.query<{ ok: boolean }>(`SELECT to_regprocedure('public.kidmais098_hoje()') IS NOT NULL AS ok`)).rows[0]?.ok);
});
test.after(async () => { if (a) await encerrarDescartavel(a); });

test("modelo 098: a 100 recusa (corpo da regra diferente do da 094) e nada muda", async (t) => {
  if (!com098) { t.skip("modelo sem a 098"); return; }
  const antes = await hashAtual();
  assert.notEqual(antes, H094);
  await recusa(a.query(arquivo(PRECHECK)), /100 precheck: corpo da regra de conflito diferente do da 094/);
  await recusa(a.query(arquivo(MIGRATION)), /100: precheck falhou \(corpo da regra de conflito diferente do da 094/);
  assert.equal(await hashAtual(), antes);
});

test("premissa (094, sem a 100): capacidade antiga 2 no horário com um salão aceita duas festas", async (t) => {
  if (com098) { t.skip("só no modelo 097"); return; }
  assert.equal(await hashAtual(), H094);
  const c = await cenario(a, 0);
  await configurar(c, "POR_HORARIO", null, 0);
  const tarde = await horario(c, "TARDE_ANTIGA", "15:00", "19:00", 2);
  await confirmada(c, tarde, "15:00", "19:00");
  await confirmada(c, tarde, "15:00", "19:00");
});

test("100: aplicada uma vez, integridade, segunda aplicação recusada; módulo Festa continua válido", async (t) => {
  if (com098) { t.skip("só no modelo 097"); return; }
  await recusa(a.query(arquivo(POSTCHECK)), /100 postcheck: corpo da regra de conflito diferente do da 100/);
  await a.query(arquivo(PRECHECK));
  await a.query(arquivo(MIGRATION));
  await a.query(arquivo(POSTCHECK));
  assert.equal(await hashAtual(), H100);
  assert.equal((await a.query<{ integra_100: boolean }>(arquivo(INTEGRIDADE))).rows[0].integra_100, true);
  await recusa(a.query(arquivo(PRECHECK)), /100 precheck: corpo da regra de conflito diferente do da 094/);
  await recusa(a.query(arquivo(MIGRATION)), /100: precheck falhou/);
  assert.equal(await hashAtual(), H100);
  assert.equal((await a.query<{ valida: boolean }>(estruturaFesta019Sql)).rows[0].valida, true);
});

test("100: com um salão, capacidade antiga 2 aceita só uma festa por vez; o TypeScript enxerga igual", async (t) => {
  if (com098) { t.skip("só no modelo 097"); return; }
  const c = await cenario(a, 0);
  await configurar(c, "POR_HORARIO", null, 60);
  const tarde = await horario(c, "TARDE_DOIS", "15:00", "19:00", 2);
  const manha = await horario(c, "MANHA_DOIS", "08:00", "11:00", 2);
  await confirmada(c, tarde, "15:00", "19:00");
  await recusa(confirmada(c, tarde, "15:00", "19:00"), /Conflito/);
  // Outro horário que não encosta (com o intervalo de 60 min) segue livre.
  await confirmada(c, manha, "08:00", "11:00");
  const agenda = await consultarDisponibilidadeData(D, tx, undefined, { empresaId: c.empresa, estabelecimentoId: null });
  assert.equal(agenda.periodos.find((p) => p.codigo === "TARDE_DOIS")?.status, "INDISPONIVEL");
});

test("100: por salão e empresa sem configuração seguem como na 094", async (t) => {
  if (com098) { t.skip("só no modelo 097"); return; }
  const s = await cenario(a, 0);
  await configurar(s, "POR_SALAO", null, 0);
  const s1 = await id(a, `INSERT INTO agenda_saloes (empresa_id, nome, ordem) VALUES ($1::uuid, 'S1', 1) RETURNING id`, [s.empresa]);
  const s2 = await id(a, `INSERT INTO agenda_saloes (empresa_id, nome, ordem) VALUES ($1::uuid, 'S2', 2) RETURNING id`, [s.empresa]);
  const cfg = await horario(s, "TARDE_SALOES", "15:00", "19:00", 2);
  await a.query(`INSERT INTO configuracao_agenda_saloes (configuracao_agenda_id, salao_id) VALUES ($1::uuid, $2::uuid), ($1::uuid, $3::uuid)`, [cfg, s1, s2]);
  await confirmada(s, cfg, "15:00", "19:00", s1);
  await confirmada(s, cfg, "15:00", "19:00", s2);
  await recusa(confirmada(s, cfg, "15:00", "19:00", s1), /Conflito/);

  const sem = await cenario(a, 0);
  const livre = await horario(sem, "TARDE_SEM_CFG", "15:00", "19:00", 3);
  await confirmada(sem, livre, "15:00", "19:00");
  await recusa(confirmada(sem, livre, "15:00", "19:00"), /Conflito/);
});

test("100 (ressalva do Astra): horários diferentes sobrepostos, intervalo no mesmo horário e limite do dia seguem como na 094", async (t) => {
  if (com098) { t.skip("só no modelo 097"); return; }
  // Horários diferentes que se sobrepõem conflitam (com qualquer capacidade gravada).
  const d = await cenario(a, 0);
  await configurar(d, "POR_HORARIO", null, 0);
  const tarde = await horario(d, "TARDE_DIF", "15:00", "19:00", 2);
  const noite = await horario(d, "NOITE_DIF", "18:00", "22:00", 2);
  await confirmada(d, tarde, "15:00", "19:00");
  await recusa(confirmada(d, noite, "18:00", "22:00"), /Conflito/);
  // Mesmo horário, festas que não se sobrepõem: com intervalo de 60 min, 15:30 depois de 15:00 conflita...
  const i = await cenario(a, 0);
  await configurar(i, "POR_HORARIO", null, 60);
  const livre = await horario(i, "LIVRE_INT", "13:00", "18:00", 2);
  await confirmada(i, livre, "13:00", "15:00");
  await recusa(confirmada(i, livre, "15:30", "17:30"), /Conflito/);
  // ...e sem intervalo, o mesmo par entra (uma festa por vez, não uma por dia no horário).
  const z = await cenario(a, 0);
  await configurar(z, "POR_HORARIO", null, 0);
  const semIntervalo = await horario(z, "LIVRE_ZERO", "13:00", "18:00", 2);
  await confirmada(z, semIntervalo, "13:00", "15:00");
  await confirmada(z, semIntervalo, "15:30", "17:30");
  // Limite do dia: com limite 1, o segundo horário (sem sobreposição) é recusado.
  const l = await cenario(a, 0);
  await configurar(l, "POR_HORARIO", 1, 0);
  const manha = await horario(l, "MANHA_LIM", "09:00", "12:00", 2);
  const tardeLim = await horario(l, "TARDE_LIM", "15:00", "19:00", 2);
  await confirmada(l, manha, "09:00", "12:00");
  await recusa(confirmada(l, tardeLim, "15:00", "19:00"), /Conflito/);
});

test("B-13: hold real de remarcação sob a 100 — capacidade gravada 2 não abre vaga; a própria festa não conta duas vezes; o hold ocupa", async (t) => {
  if (com098) { t.skip("só no modelo 097"); return; }
  assert.equal(await hashAtual(), H100);
  // A conferência de agenda é ADIADA (no COMMIT): aqui roda na hora (SET CONSTRAINTS … IMMEDIATE) dentro de um savepoint,
  // e o ROLLBACK final desfaz o cenário inteiro.
  const agora = async () => a.query("SET CONSTRAINTS fr_agenda_validar_trg, fr_confirmacao_agenda_trg IMMEDIATE");
  const desfazer = async () => { await a.query("ROLLBACK TO SAVEPOINT h"); await a.query("SET CONSTRAINTS fr_agenda_validar_trg, fr_confirmacao_agenda_trg DEFERRED"); };
  const hold = async (revisao: string) => { await a.query(`UPDATE fechamento_revisoes SET hold_destino_adquirido_em = clock_timestamp() WHERE id = $1::uuid`, [revisao]); await agora(); };
  /** Festa confirmada dentro da transação do teste (savepoint próprio), conferida na hora. */
  const ocupar = async (c: Cenario, cfg: string, data: string, inicio: string, fim: string) => {
    await a.query("SAVEPOINT o");
    const f = await id(a, `INSERT INTO fechamentos (data_evento, horario_inicio, horario_fim, configuracao_agenda_id, empresa_id, pacote_id, tabela_preco_id, preco_pacote_id,
          categoria_horario, categoria_preco_aplicada, convidados, convidados_faturados, valor_pacote_base, valor_pacote_aplicado, valor_tabela, origem_fechamento, cliente_id, status)
        SELECT $1::date, $2::time, $3::time, $4::uuid, $5::uuid, p.id, pp.tabela_preco_id, pp.id, 'PADRAO', 'PADRAO', 10, 10, 100, 100, 100,
               'ATENDIMENTO_KIDMAIS', NULL, 'AGUARDANDO_CONTRATO' FROM pacotes p JOIN precos_pacote pp ON pp.pacote_id = p.id WHERE p.id = $6::uuid RETURNING fechamentos.id`,
      [data, inicio, fim, cfg, c.empresa, c.pacote]);
    await a.query(`UPDATE fechamentos SET status = 'CONFIRMADO' WHERE id = $1::uuid`, [f]);
    try { await agora(); await a.query("SET CONSTRAINTS fr_agenda_validar_trg, fr_confirmacao_agenda_trg DEFERRED"); await a.query("RELEASE SAVEPOINT o"); return f; }
    catch (error) { await a.query("ROLLBACK TO SAVEPOINT o"); await a.query("SET CONSTRAINTS fr_agenda_validar_trg, fr_confirmacao_agenda_trg DEFERRED"); throw error; }
  };
  await a.query("BEGIN");
  try {
    const c = await cenario(a, 0);
    await configurar(c, "POR_HORARIO", null, 0);
    // Capacidade GRAVADA 2: na 094 o destino ocupado ainda teria vaga; na 100 é uma festa por vez.
    const tarde = await horario(c, `TARDE_B13_${randomUUID().slice(0, 6)}`, "15:00", "19:00", 2);
    const D2 = dia(64), D3 = dia(65);
    const ocupante = await ocupar(c, tarde, D2, "15:00", "19:00");
    const { festa, cfg, revisao } = await integradaComRevisao(c, { data: D2, inicio: "09:00", fim: "13:00" });
    assert.equal(cfg, tarde);
    const destino = (data: string, inicio: string, fim: string) => a.query(
      `UPDATE fechamento_revisoes SET data_evento = $2::date, configuracao_agenda_id = $3::uuid, horario_inicio = $4::time, horario_fim = $5::time WHERE id = $1::uuid`,
      [revisao, data, tarde, inicio, fim]);

    // 1. Destino 15h–19h em D2, ocupado pela outra festa: a 100 recusa o hold mesmo com capacidade gravada 2.
    await destino(D2, "15:00", "19:00");
    await a.query("SAVEPOINT h");
    await recusaSemRollback(hold(revisao), /Conflito de agenda da revisão/);
    await desfazer();
    // 2. Controle: o mesmo horário em D3 (livre) aceita o hold; a festa passa a ocupar origem (D2) e destino (D3).
    await destino(D3, "15:00", "19:00");
    await a.query("SAVEPOINT h");
    await hold(revisao);
    const noDestino = await a.query<{ fechamento_id: string; origem: string }>(
      `SELECT fechamento_id::text, origem FROM kidmais094_ocupacoes($1::date, $1::date) WHERE configuracao_agenda_id = $2::uuid`, [D3, tarde]);
    assert.deepEqual(noDestino.rows, [{ fechamento_id: festa, origem: "REVISAO_DESTINO" }]);
    // 3. O hold OCUPA: outra festa no destino em hold é recusada pela 100 (capacidade gravada 2 não abre vaga)...
    await recusaSemRollback(ocupar(c, tarde, D3, "15:00", "19:00"), /Conflito/);
    await desfazer();
    // ...e, sem o hold, a mesma festa entra (controle).
    await a.query("SAVEPOINT h");
    await ocupar(c, tarde, D3, "15:00", "19:00");
    await desfazer();
    // 4. Destino 10h–14h em D2, sobreposto só à PRÓPRIA origem (09h–13h): a festa não conta duas vezes; aceito.
    await destino(D2, "10:00", "14:00");
    await a.query("SAVEPOINT h");
    await hold(revisao);
    await desfazer();
    assert.ok(ocupante);
  } finally {
    await a.query("ROLLBACK");
  }
});

test("B-13: configuração distinta sob a 100 — intervalo só no mesmo horário, sobreposição real recusa, capacidade gravada 3 não abre vaga", async (t) => {
  if (com098) { t.skip("só no modelo 097"); return; }
  assert.equal(await hashAtual(), H100);
  const c = await cenario(a, 0);
  await configurar(c, "POR_HORARIO", null, 60);
  const A = await horario(c, "B13_A", "13:00", "18:00", 2);
  const B = await horario(c, "B13_B", "13:00", "18:00", 3);
  await confirmada(c, A, "13:00", "15:00");
  // Outra configuração: só a sobreposição REAL conflita (o intervalo de 60 min vale dentro do mesmo horário, como na 094).
  await recusa(confirmada(c, B, "14:30", "16:30"), /Conflito/);
  await confirmada(c, B, "15:30", "17:30");
  // Controle do intervalo no mesmo horário: em A, 15:30 depois de 15:00 conflita (60 min) — e também com B (sobreposição).
  const ctrl = await cenario(a, 0);
  await configurar(ctrl, "POR_HORARIO", null, 60);
  const A2 = await horario(ctrl, "B13_A2", "13:00", "18:00", 2);
  const B2 = await horario(ctrl, "B13_B2", "13:00", "18:00", 3);
  await confirmada(ctrl, A2, "13:00", "15:00");
  await recusa(confirmada(ctrl, A2, "15:30", "17:30"), /Conflito/);
  // Encostar sem sobrepor noutra configuração entra (fim 15:00 = início 15:00).
  await confirmada(ctrl, B2, "15:00", "17:00");
  // Capacidade gravada 3 em B não abre segunda festa no mesmo horário (100: uma por vez).
  await recusa(confirmada(c, B, "15:30", "17:30"), /Conflito/);
  const agenda = await consultarDisponibilidadeData(D, tx, undefined, { empresaId: c.empresa, estabelecimentoId: null });
  assert.equal(agenda.periodos.find((p) => p.codigo === "B13_B")?.status, "INDISPONIVEL");
});

test("B-13: unidades distintas sob a 100 — o horário e o limite do dia contam por unidade", async (t) => {
  if (com098) { t.skip("só no modelo 097"); return; }
  assert.equal(await hashAtual(), H100);
  const c = await cenario(a, 2);
  const [u1, u2] = c.unidades as string[];
  assert.ok(u1 && u2 && u1 !== u2);
  // A 043 cria a unidade SUSPENSO e não a deixa ir a ATIVO aqui; a agenda usa a unidade não desativada e habilitada (062).
  for (const u of [u1, u2]) await habilitar(c, u);
  await configurar(c, "POR_HORARIO", 1, 0, u1);
  await configurar(c, "POR_HORARIO", 1, 0, u2);
  const tarde1 = await horario(c, "B13_TARDE_U1", "15:00", "19:00", 2, u1);
  const manha1 = await horario(c, "B13_MANHA_U1", "09:00", "12:00", 2, u1);
  const tarde2 = await horario(c, "B13_TARDE_U2", "15:00", "19:00", 2, u2);
  const manha2 = await horario(c, "B13_MANHA_U2", "09:00", "12:00", 2, u2);
  await confirmada(c, tarde1, "15:00", "19:00", null, u1);
  // Outra unidade, mesmo horário: recurso diferente; o limite 1 da U2 ainda está livre.
  await confirmada(c, tarde2, "15:00", "19:00", null, u2);
  // Na mesma unidade: segunda festa no horário (capacidade gravada 2) e outro horário (limite 1) são recusados.
  await recusa(confirmada(c, tarde1, "15:00", "19:00", null, u1), /Conflito/);
  await recusa(confirmada(c, manha1, "09:00", "12:00", null, u1), /Conflito/);
  await recusa(confirmada(c, manha2, "09:00", "12:00", null, u2), /Conflito/);
  // Controle do limite: noutro dia, a manhã da U1 entra.
  await confirmada(c, manha1, "09:00", "12:00", null, u1, dia(46));

  // Revisão do Astra (B-13, P3-1): o limite 1 acima recusa antes da regra do horário. Sem limite diário, com capacidade
  // gravada 2, o filtro de unidade fica isolado nos ramos de horário (sobreposição noutra configuração e um por vez).
  const s = await cenario(a, 2);
  const [v1, v2] = s.unidades as string[];
  for (const u of [v1, v2]) { await habilitar(s, u); await configurar(s, "POR_HORARIO", null, 0, u); }
  const tardeV1 = await horario(s, "B13_SL_TARDE_U1", "15:00", "19:00", 2, v1);
  const tardeV2 = await horario(s, "B13_SL_TARDE_U2", "15:00", "19:00", 2, v2);
  const manhaV1 = await horario(s, "B13_SL_MANHA_U1", "09:00", "12:00", 2, v1);
  await confirmada(s, tardeV1, "15:00", "19:00", null, v1);
  await confirmada(s, tardeV2, "15:00", "19:00", null, v2);
  await recusa(confirmada(s, tardeV1, "15:00", "19:00", null, v1), /Conflito/);
  await recusa(confirmada(s, tardeV2, "15:00", "19:00", null, v2), /Conflito/);
  // Sem limite, outro horário da mesma unidade no mesmo dia entra (controle: o limite era o que recusava acima).
  await confirmada(s, manhaV1, "09:00", "12:00", null, v1);
});

test("B-13 (P3-2): hold de remarcação na U1 ocupa só a U1 — a U2 segue livre no mesmo horário", async (t) => {
  if (com098) { t.skip("só no modelo 097"); return; }
  assert.equal(await hashAtual(), H100);
  const agora = async () => a.query("SET CONSTRAINTS fr_agenda_validar_trg, fr_confirmacao_agenda_trg IMMEDIATE");
  const adiar = async () => a.query("SET CONSTRAINTS fr_agenda_validar_trg, fr_confirmacao_agenda_trg DEFERRED");
  const ocupar = async (c: Cenario, cfg: string, data: string, unidade: string) => {
    await a.query("SAVEPOINT o");
    const f = await id(a, `INSERT INTO fechamentos (data_evento, horario_inicio, horario_fim, configuracao_agenda_id, empresa_id, pacote_id, tabela_preco_id, preco_pacote_id,
          categoria_horario, categoria_preco_aplicada, convidados, convidados_faturados, valor_pacote_base, valor_pacote_aplicado, valor_tabela, origem_fechamento, cliente_id, status, estabelecimento_id)
        SELECT $1::date, '15:00', '19:00', $2::uuid, $3::uuid, p.id, pp.tabela_preco_id, pp.id, 'PADRAO', 'PADRAO', 10, 10, 100, 100, 100,
               'ATENDIMENTO_KIDMAIS', NULL, 'AGUARDANDO_CONTRATO', $5::uuid FROM pacotes p JOIN precos_pacote pp ON pp.pacote_id = p.id WHERE p.id = $4::uuid RETURNING fechamentos.id`,
      [data, cfg, c.empresa, c.pacote, unidade]);
    await a.query(`UPDATE fechamentos SET status = 'CONFIRMADO' WHERE id = $1::uuid`, [f]);
    try { await agora(); await adiar(); await a.query("RELEASE SAVEPOINT o"); return f; }
    catch (error) { await a.query("ROLLBACK TO SAVEPOINT o"); await adiar(); throw error; }
  };
  await a.query("BEGIN");
  try {
    const c = await cenario(a, 2);
    const [u1, u2] = c.unidades as string[];
    for (const u of [u1, u2]) { await habilitar(c, u); await configurar(c, "POR_HORARIO", null, 0, u); }
    const tarde1 = await horario(c, `B13_HU1_${randomUUID().slice(0, 6)}`, "15:00", "19:00", 2, u1);
    const tarde2 = await horario(c, `B13_HU2_${randomUUID().slice(0, 6)}`, "15:00", "19:00", 2, u2);
    const D2 = dia(66), D3 = dia(67);
    const { festa, cfg, revisao } = await integradaComRevisao(c, { data: D2, inicio: "15:00", fim: "19:00" }, u1);
    assert.equal(cfg, tarde1, "a festa integrada ficou no horário da U1");
    assert.equal((await a.query<{ u: string }>(`SELECT estabelecimento_id::text u FROM fechamentos WHERE id = $1`, [festa])).rows[0].u, u1);
    // Hold de destino em D3, mesmo horário da U1.
    await a.query(`UPDATE fechamento_revisoes SET data_evento = $2::date, configuracao_agenda_id = $3::uuid, horario_inicio = '15:00', horario_fim = '19:00' WHERE id = $1::uuid`,
      [revisao, D3, tarde1]);
    await a.query(`UPDATE fechamento_revisoes SET hold_destino_adquirido_em = clock_timestamp() WHERE id = $1::uuid`, [revisao]);
    await agora();
    await adiar();
    // O hold ocupa a U1 em D3 (capacidade gravada 2 não abre vaga)...
    await recusaSemRollback(ocupar(c, tarde1, D3, u1), /Conflito/);
    // ...e a U2, no mesmo dia e horário, segue livre.
    await ocupar(c, tarde2, D3, u2);
  } finally {
    await a.query("ROLLBACK");
  }
});

test("100: a 098 recusa por cima da 100; rollback volta o corpo da 094 e só aceita o corpo da 100", async (t) => {
  if (com098) { t.skip("só no modelo 097"); return; }
  await recusa(a.query(arquivo("database/migrations/20261023_098_saloes_combinados.sql")), /098: precheck falhou \(corpos da 094 divergentes\)/);
  assert.equal(await hashAtual(), H100);
  await a.query(arquivo(ROLLBACK));
  assert.equal(await hashAtual(), H094);
  await recusa(a.query(arquivo(ROLLBACK)), /100 rollback: corpo atual não é o da 100/);
  assert.equal(await hashAtual(), H094);
  // Sem a 100, a capacidade gravada volta a valer (comportamento da 094); reaplicar a 100 fecha de novo.
  const c = await cenario(a, 0);
  await configurar(c, "POR_HORARIO", null, 0);
  const tarde = await horario(c, "TARDE_VOLTA", "15:00", "19:00", 2);
  await confirmada(c, tarde, "15:00", "19:00");
  await confirmada(c, tarde, "15:00", "19:00");
  await a.query(arquivo(MIGRATION));
  assert.equal(await hashAtual(), H100);
  const d = await cenario(a, 0);
  await configurar(d, "POR_HORARIO", null, 0);
  const outra = await horario(d, "TARDE_REAPLICADA", "15:00", "19:00", 2);
  await confirmada(d, outra, "15:00", "19:00");
  await recusa(confirmada(d, outra, "15:00", "19:00"), /Conflito/);
});
