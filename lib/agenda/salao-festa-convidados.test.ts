import test from "node:test";
import assert from "node:assert/strict";
import { executorFalso } from "../acessos/teste-carregador.ts";
import type { DbExecutor } from "../db/contracts.ts";
import { escolherSalao, escolherSalaoDestinoRevisao } from "./salao-festa.ts";

/**
 * S-C (P3-T1 do Astra): a escolha do salão recebe os convidados da PRÓPRIA linha — da festa na confirmação e da revisão
 * na remarcação (fechamento_revisoes.convidados, não os da festa original) — e os usa só para ordenar, depois do
 * preferido/atual. A ordenação em si é provada no PostgreSQL (convidados-primeiro-sc.postgres.test.ts).
 */
const ORDENACAO = /ORDER BY \(s\.id = \$9::uuid\) DESC NULLS LAST, COALESCE\(s\.capacidade_convidados >= \$10::int, true\) DESC, s\.ordem, s\.nome/;

function banco(linha: Record<string, unknown>) {
  return executorFalso([
    [/to_regprocedure\('public\.kidmais094_conflito_ocupacao/, () => [{ ok: true }]],
    [/to_regprocedure\('public\.kidmais098_salao_elegivel/, () => [{ ok: false }]],
    [/FROM fechamento_revisoes r JOIN fechamentos f/, () => [linha]],
    [/FROM fechamentos f WHERE f\.id = \$1::uuid FOR UPDATE/, () => [linha]],
    [/FROM agenda_saloes s/, () => [{ id: "salao-grande" }]],
    [/^UPDATE /, () => []],
  ]);
}
const comum = { por_salao: true, data: "2026-12-05", inicio: "15:00:00", fim: "19:00:00", cfg: "cfg", pacote: "pac", empresa: "emp", unidade: null };

test("S-C: remarcação usa os convidados da REVISÃO na escolha do salão do destino", async () => {
  const b = banco({ ...comum, fechamento_id: "festa", salao_atual: "salao-pequeno", salao_destino: null, estado: "EM_ELABORACAO", convidados: 110 });
  const r = await escolherSalaoDestinoRevisao(b as unknown as DbExecutor, "rev");
  assert.deepEqual(r, { exigido: true, salao: "salao-grande" });
  const selecao = b.executados.find((e) => /FROM fechamento_revisoes r JOIN fechamentos f/.test(e.sql))!;
  assert.match(selecao.sql, /r\.convidados/, "lê os convidados da revisão");
  const escolha = b.executados.find((e) => /FROM agenda_saloes s/.test(e.sql))!;
  assert.match(escolha.sql, ORDENACAO);
  assert.equal(escolha.params[8], "salao-pequeno", "o salão atual continua preferido");
  assert.equal(escolha.params[9], 110, "convidados da revisão no $10");
});

test("S-C: confirmação usa os convidados da festa; sem convidados ($10 nulo) a ordem é a de antes", async () => {
  const b = banco({ ...comum, salao_id: null, convidados: 80 });
  assert.deepEqual(await escolherSalao(b as unknown as DbExecutor, "festa"), { exigido: true, salao: "salao-grande" });
  const escolha = b.executados.find((e) => /FROM agenda_saloes s/.test(e.sql))!;
  assert.match(b.executados.find((e) => /FOR UPDATE/.test(e.sql))!.sql, /f\.convidados/);
  assert.match(escolha.sql, ORDENACAO);
  assert.equal(escolha.params[9], 80);
  const semNumero = banco({ ...comum, salao_id: null, convidados: null });
  await escolherSalao(semNumero as unknown as DbExecutor, "festa");
  assert.equal(semNumero.executados.find((e) => /FROM agenda_saloes s/.test(e.sql))!.params[9], null, "COALESCE(... >= NULL, true): todos empatam");
});
