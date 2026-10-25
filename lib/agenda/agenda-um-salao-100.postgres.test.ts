import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";
import type { DbExecutor } from "../db/contracts.ts";
import { estruturaFesta019Sql } from "../festas/estrutura-019.ts";
import { cenario, dia, id, type Cenario } from "../../scripts/integracao-importados-test-support.ts";
import { consultarDisponibilidadeData } from "../disponibilidade/services/availability.service.ts";

/**
 * 100 no PostgreSQL DESCARTÁVEL (modelo 097 = staging de hoje: 093–097 sem a 098; e modelo 098 para a recusa).
 * Decisão de Felipe (25/10/2026) e parecer do Astra (P1): com um salão (POR_HORARIO), a regra central do banco aceita
 * uma festa por vez no horário mesmo que a linha guarde capacidade maior; por salão, limite do dia, horários diferentes
 * e empresa sem configuração ficam como na 094. Rollback volta o corpo da 094; a 098 recusa por cima da 100.
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
const D = dia(45);

async function recusa(promessa: Promise<unknown>, trecho: RegExp) {
  await assert.rejects(promessa, (e: unknown) => trecho.test(e instanceof Error ? e.message : String(e)));
  await a.query("ROLLBACK").catch(() => undefined);
}

const hashAtual = async () => (await a.query<{ h: string }>(
  `SELECT encode(sha256(convert_to(replace(prosrc, E'\\r', ''), 'UTF8')), 'hex') AS h FROM pg_proc WHERE oid = to_regprocedure('public.${ASSINATURA}')`)).rows[0]?.h;

async function horario(c: Cenario, codigo: string, inicio: string, fim: string, capacidade = 1) {
  return id(a, `INSERT INTO configuracao_agenda (codigo, nome, horario_inicio_padrao, horario_fim_padrao, tolerancia_inicio_minutos, passo_inicio_minutos,
                ordem_exibicao, empresa_id, capacidade) VALUES ($1, $1, $2, $3, 0, 30, 1, $4::uuid, $5) RETURNING id`, [codigo, inicio, fim, c.empresa, capacidade]);
}

async function configurar(c: Cenario, tipo: "POR_HORARIO" | "POR_SALAO", limite: number | null, intervalo: number) {
  await a.query(`INSERT INTO agenda_escopo_config (empresa_id, modo, capacidade_tipo, limite_festas_dia, intervalo_minimo_minutos, configurado_por)
                 VALUES ($1::uuid, 'FIXO', $2, $3, $4, $5::uuid)`, [c.empresa, tipo, limite, intervalo, c.usuario]);
}

/** Festa gravada e confirmada numa transação: os gatilhos diferidos conferem a agenda no COMMIT. */
async function confirmada(c: Cenario, cfg: string, inicio: string, fim: string, salao: string | null = null) {
  await a.query("BEGIN");
  try {
    const f = await id(a, `INSERT INTO fechamentos (data_evento, horario_inicio, horario_fim, configuracao_agenda_id, empresa_id, pacote_id, tabela_preco_id, preco_pacote_id,
          categoria_horario, categoria_preco_aplicada, convidados, convidados_faturados, valor_pacote_base, valor_pacote_aplicado, valor_tabela, origem_fechamento, cliente_id, status, salao_id)
        SELECT $1::date, $2::time, $3::time, $4::uuid, $5::uuid, p.id, pp.tabela_preco_id, pp.id, 'PADRAO', 'PADRAO', 10, 10, 100, 100, 100,
               'ATENDIMENTO_KIDMAIS', NULL, 'AGUARDANDO_CONTRATO', $7::uuid FROM pacotes p JOIN precos_pacote pp ON pp.pacote_id = p.id WHERE p.id = $6::uuid RETURNING fechamentos.id`,
      [D, inicio, fim, cfg, c.empresa, c.pacote, salao]);
    await a.query(`UPDATE fechamentos SET status = 'CONFIRMADO' WHERE id = $1::uuid`, [f]);
    await a.query("COMMIT");
    return f;
  } catch (error) {
    await a.query("ROLLBACK");
    throw error;
  }
}

test.before(async () => {
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
