import assert from "node:assert/strict";
import test from "node:test";
import type { DbExecutor } from "../db/contracts.ts";
import type { ModelUsage } from "../inteligencia/contratos.ts";
import type { PedidoReserva } from "../inteligencia/modelos/orcamento.ts";
import { criarRegistroUsoPostgres, type BancoUso } from "./uso.ts";

const EMPRESA = "11111111-1111-4111-8111-111111111111";

type Consulta = { sql: string; values: readonly unknown[]; transacao: number | null };

/** Banco falso: registra cada consulta e em qual transação ela rodou. */
function banco(responder: (sql: string, values: readonly unknown[]) => { rows: object[]; rowCount?: number }) {
  const consultas: Consulta[] = [];
  let transacoes = 0;
  const executor = (transacao: number | null): DbExecutor => ({
    async query<Row extends object>(sql: string, values: readonly unknown[] = []) {
      consultas.push({ sql, values, transacao });
      const r = responder(sql, values);
      return { rows: r.rows as Row[], rowCount: r.rowCount ?? r.rows.length };
    },
  });
  const b: BancoUso = { executor: () => executor(null), transacao: async (trabalho) => trabalho(executor(++transacoes)) };
  return { b, consultas };
}

const uso = (parcial: Partial<ModelUsage> = {}): ModelUsage => ({
  correlationId: "req-1", empresaId: EMPRESA, estabelecimentoId: null, capacidade: "classificar_intencao", workload: "CLASSIFICAR_INTENCAO", tier: "ECONOMY",
  provedor: "OPENAI", modelo: "m", tokensEntrada: 10, tokensSaida: 2, tokensCache: null, duracaoMs: 5, custoEstimadoMicros: null, moeda: null,
  sucesso: true, erro: null, fallback: false, em: "2026-09-28T15:00:00.000Z", ...parcial,
});

const pedido: PedidoReserva = {
  id: "00000001-0000-4000-8000-00000000000a", empresaId: EMPRESA, capacidade: "classificar_intencao", correlationId: "req-1", em: "2026-09-28T15:00:00.000Z",
  periodos: { dia: "2026-09-28", mes: "2026-09" },
  tokens: 600, custoMicros: 1200, moeda: "USD",
  limites: [{ escopo: "EMPRESA", capacidade: null, periodo: { tipo: "DIA", chave: "2026-09-28" }, tokensMax: 1000, custoMaxMicros: null }],
};

const comTabela = (consumo: { tokens: string; custo: string; desconhecido: boolean }) => (sql: string) => {
  if (sql.includes("to_regclass")) return { rows: [{ ok: true }] };
  if (sql.includes("WITH ia_uso_periodo")) return { rows: [consumo] };
  return { rows: [] };
};

test("sem as tabelas da 055a: uso vira linha de log (sem PII) e a reserva é recusada (fail closed)", async () => {
  const linhas: string[] = [];
  const { b } = banco((sql) => ({ rows: sql.includes("to_regclass") ? [{ ok: false }] : [] }));
  const registro = criarRegistroUsoPostgres(b, (l) => linhas.push(l));
  await registro.registrar(uso());
  assert.match(linhas[0], /^\[Kidmais IA uso\] \{/);
  assert.deepEqual(await registro.reservar(pedido), { ok: false, motivo: "INDISPONIVEL", recusa: { motivo: "REGISTRO_INDISPONIVEL", escopo: null, periodo: null } });
});

test("reserva: advisory lock por empresa, saldo do PERÍODO FIXO e INSERT com o período, na MESMA transação", async () => {
  const { b, consultas } = banco(comTabela({ tokens: "300", custo: "0", desconhecido: false }));
  assert.deepEqual(await criarRegistroUsoPostgres(b).reservar(pedido), { ok: true });
  const daReserva = consultas.filter((c) => c.transacao === 1);
  assert.match(daReserva[1].sql, /pg_advisory_xact_lock\(hashtext\('kidmais-ia-orcamento'\), hashtext\(\$1::text\)\)/);
  assert.deepEqual(daReserva[1].values, [EMPRESA]);
  assert.match(daReserva[2].sql, /periodo_dia = \$2::date/, "consumo pelo período fixo, não por horário");
  assert.match(daReserva[2].sql, /estado IN \('ABERTA', 'USO_DESCONHECIDO', 'ORFA'\)/);
  assert.deepEqual(daReserva[2].values, [EMPRESA, "2026-09-28", null, null, "USD"]);
  assert.match(daReserva[3].sql, /^\s*INSERT INTO ia_orcamento_reservas/);
  assert.deepEqual(daReserva[3].values.slice(8), ["2026-09-28", "2026-09"], "a reserva grava o período");
  assert.equal(new Set(daReserva.map((c) => c.transacao)).size, 1);
});

test("limite mensal usa a chave do mês", async () => {
  const mensal: PedidoReserva = { ...pedido, limites: [{ escopo: "EMPRESA", capacidade: null, periodo: { tipo: "MES", chave: "2026-09" }, tokensMax: 1000, custoMaxMicros: null }] };
  const { b, consultas } = banco(comTabela({ tokens: "0", custo: "0", desconhecido: false }));
  await criarRegistroUsoPostgres(b).reservar(mensal);
  assert.deepEqual(consultas.find((c) => c.sql.includes("WITH ia_uso_periodo"))!.values, [EMPRESA, null, "2026-09", null, "USD"]);
});

test("reserva recusada quando uso + reservas abertas + nova reserva passam do limite; nada é inserido", async () => {
  const { b, consultas } = banco(comTabela({ tokens: "401", custo: "0", desconhecido: false }));
  assert.deepEqual(await criarRegistroUsoPostgres(b).reservar(pedido), { ok: false, motivo: "ORCAMENTO", recusa: { motivo: "TETO_TOKENS", escopo: "EMPRESA", periodo: "DIA" } });
  assert.equal(consultas.some((c) => c.sql.includes("INSERT INTO ia_orcamento_reservas")), false);
});

test("limite de custo: custo desconhecido ou em outra moeda no período bloqueia; moedas nunca se somam", async () => {
  const comCusto: PedidoReserva = { ...pedido, limites: [{ ...pedido.limites[0], tokensMax: null, custoMaxMicros: 1_000_000 }] };
  const { b, consultas } = banco(comTabela({ tokens: "0", custo: "0", desconhecido: true }));
  assert.deepEqual(await criarRegistroUsoPostgres(b).reservar(comCusto), { ok: false, motivo: "ORCAMENTO", recusa: { motivo: "CUSTO_DESCONHECIDO", escopo: "EMPRESA", periodo: "DIA" } });
  const sql = consultas.find((c) => c.sql.includes("WITH ia_uso_periodo"))!.sql;
  assert.match(sql, /WHERE moeda = \$5/, "soma só a moeda do orçamento");
  assert.match(sql, /moeda IS DISTINCT FROM \$5/, "outra moeda conta como desconhecido");
});

test("reconciliação depois da virada do dia: fecha a MESMA reserva e o uso herda o período dela", async () => {
  const { b, consultas } = banco((sql) => (sql.startsWith("UPDATE") ? { rows: [{ periodo_dia: "2026-09-28", periodo_mes: "2026-09" }], rowCount: 1 } : { rows: [] }));
  const registro = criarRegistroUsoPostgres(b);
  // 00:00:05 de 29/09 em São Paulo; a reserva nasceu em 28/09.
  await registro.reconciliar(pedido.id, uso({ tokensEntrada: null, tokensSaida: null, erro: "TIMEOUT", sucesso: false, em: "2026-09-29T03:00:05.000Z" }));
  assert.match(consultas[0].sql, /WHERE id = \$1::uuid AND empresa_id = \$2::uuid/);
  assert.match(consultas[0].sql, /estado = 'ABERTA' OR \(estado = 'ORFA' AND \$3 <> 'LIBERADA'\)/);
  assert.match(consultas[0].sql, /RETURNING periodo_dia::text AS periodo_dia, periodo_mes/);
  assert.deepEqual(consultas[0].values, [pedido.id, EMPRESA, "USO_DESCONHECIDO"]);
  assert.match(consultas[1].sql, /INSERT INTO ia_uso_modelo/);
  assert.equal(consultas[1].values[8], null, "tokens desconhecidos ficam null, nunca zero");
  assert.equal(consultas[1].values[18], pedido.id);
  assert.deepEqual(consultas[1].values.slice(19), ["2026-09-28", "2026-09"], "virada de dia não move o consumo");
  assert.equal(consultas[0].transacao, consultas[1].transacao);
  await registro.liberar(pedido.id, uso({ tokensEntrada: 0, tokensSaida: 0, erro: "HTTP_4XX", sucesso: false }));
  assert.equal(consultas[2].values[2], "LIBERADA");
});

test("falha ao reconciliar não é engolida pelo repositório: reserva já encerrada ⇒ erro", async () => {
  const { b } = banco((sql) => (sql.startsWith("UPDATE") ? { rows: [], rowCount: 0 } : { rows: [] }));
  await assert.rejects(criarRegistroUsoPostgres(b).reconciliar(pedido.id, uso()), /RESERVA_INEXISTENTE_OU_ENCERRADA/);
});

test("órfã: rotina controlada marca ABERTA antiga como ORFA (continua contando); nada é apagado", async () => {
  const { b, consultas } = banco(() => ({ rows: [], rowCount: 2 }));
  assert.equal(await criarRegistroUsoPostgres(b).recuperarOrfas("2026-09-28T14:45:00.000Z", EMPRESA), 2);
  assert.match(consultas[0].sql, /SET estado = 'ORFA'/);
  assert.match(consultas[0].sql, /WHERE estado = 'ABERTA' AND criado_em < \$1::timestamptz/);
  assert.doesNotMatch(consultas[0].sql, /DELETE/);
});

test("uso sem reserva cai no dia de São Paulo de criado_em", async () => {
  const { b, consultas } = banco((sql) => (sql.includes("to_regclass") ? { rows: [{ ok: true }] } : { rows: [] }));
  await criarRegistroUsoPostgres(b).registrar(uso());
  const insert = consultas.find((c) => c.sql.includes("INSERT INTO ia_uso_modelo"))!;
  assert.match(insert.sql, /COALESCE\(\$20::date, \(\$18::timestamptz AT TIME ZONE 'America\/Sao_Paulo'\)::date\)/);
  assert.deepEqual(insert.values.slice(19), [null, null]);
});

test("B1 paridade memória × PostgreSQL: reserva sem teto aplicável/utilizável é recusada nos dois, antes de qualquer transação", async () => {
  const { criarRegistroUsoEmMemoria } = await import("../inteligencia/modelos/orcamento.ts");
  const semTeto = [
    [],
    [{ escopo: "EMPRESA" as const, capacidade: null, periodo: { tipo: "DIA" as const, chave: "2026-09-28" }, tokensMax: null, custoMaxMicros: null }],
    [{ escopo: "EMPRESA" as const, capacidade: null, periodo: { tipo: "DIA" as const, chave: "2026-09-28" }, tokensMax: 0, custoMaxMicros: 0 }],
    [pedido.limites[0], { escopo: "CAPACIDADE" as const, capacidade: "x", periodo: { tipo: "MES" as const, chave: "2026-09" }, tokensMax: null, custoMaxMicros: null }],
  ];
  for (const limites of semTeto) {
    const { b, consultas } = banco(comTabela({ tokens: "0", custo: "0", desconhecido: false }));
    assert.deepEqual(await criarRegistroUsoPostgres(b).reservar({ ...pedido, limites }), { ok: false, motivo: "ORCAMENTO", recusa: { motivo: "SEM_TETO", escopo: null, periodo: null } }, JSON.stringify(limites));
    assert.equal(consultas.length, 0, "nada é consultado nem inserido");
    assert.deepEqual(await criarRegistroUsoEmMemoria().reservar({ ...pedido, limites }), { ok: false, motivo: "ORCAMENTO", recusa: { motivo: "SEM_TETO", escopo: null, periodo: null } }, JSON.stringify(limites));
  }
  // Com teto válido os dois aceitam.
  const { b } = banco(comTabela({ tokens: "0", custo: "0", desconhecido: false }));
  assert.deepEqual(await criarRegistroUsoPostgres(b).reservar(pedido), { ok: true });
  assert.deepEqual(await criarRegistroUsoEmMemoria().reservar(pedido), { ok: true });
});

test("H3: detalhe saneado do erro do provedor é só do trace — nem no log de fallback nem no INSERT da 055a", async () => {
  const comDetalhe = uso({ sucesso: false, erro: "HTTP_4XX", tokensEntrada: 0, tokensSaida: 0, detalheErro: { status: 429, tipo: "insufficient_quota", codigo: "credit_balance_exhausted", parametro: null } });
  const linhas: string[] = [];
  const semTabela = banco((sql) => ({ rows: sql.includes("to_regclass") ? [{ ok: false }] : [] }));
  await criarRegistroUsoPostgres(semTabela.b, (l) => linhas.push(l)).registrar(comDetalhe);
  assert.equal(linhas.length, 1);
  assert.equal(/detalheErro|credit_balance_exhausted|insufficient_quota/.test(linhas[0]), false);
  const comTab = banco(comTabela({ tokens: "0", custo: "0", desconhecido: false }));
  await criarRegistroUsoPostgres(comTab.b).registrar(comDetalhe);
  const insert = comTab.consultas.find((c) => c.sql.includes("INSERT INTO ia_uso_modelo"));
  assert.ok(insert);
  assert.equal(JSON.stringify(insert.values).includes("credit_balance_exhausted"), false);
  assert.ok(insert.values.includes("HTTP_4XX"), "a 055a guarda só a causa");
});
