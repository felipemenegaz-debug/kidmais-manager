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

function banco(linha: Record<string, unknown>, servem: (somente: unknown) => Array<{ id: string }> = () => [{ id: "salao-grande" }]) {
  return executorFalso([
    [/to_regprocedure\('public\.kidmais094_conflito_ocupacao/, () => [{ ok: true }]],
    [/to_regprocedure\('public\.kidmais098_salao_elegivel/, () => [{ ok: false }]],
    [/attname = 'convidados_minimo'/, () => [{ ok: true }]],
    [/FROM fechamento_revisoes r JOIN fechamentos f/, () => [linha]],
    [/FROM fechamentos f WHERE f\.id = \$1::uuid FOR UPDATE/, () => [linha]],
    // saloesQueServem (S-E): $10 = só este salão; salaoElegivelLivre (confirmação, S-C) não tem $10.
    [/\$10::uuid IS NULL OR s\.id = \$10::uuid/, (p) => servem(p[9])],
    [/FROM agenda_saloes s/, () => [{ id: "salao-grande" }]],
    [/^UPDATE /, () => []],
  ]);
}
const ESTRITO = /\$9::int IS NULL OR \(\(s\.capacidade_convidados IS NULL OR \$9::int <= s\.capacidade_convidados\) AND \(s\.convidados_minimo IS NULL OR \$9::int >= s\.convidados_minimo\)\)/;
const comum = { por_salao: true, data: "2026-12-05", inicio: "15:00:00", fim: "19:00:00", cfg: "cfg", pacote: "pac", empresa: "emp", unidade: null };

test("S-C/S-E: remarcação usa os convidados da REVISÃO; o salão atual que não comporta dá lugar ao menor que comporta", async () => {
  // P2 do Astra (27/10): o destino é ESTRITO (o documento V3 fixa o salão). O pequeno não comporta 110 → o grande.
  const b = banco({ ...comum, fechamento_id: "festa", salao_atual: "salao-pequeno", salao_destino: null, estado: "EM_ELABORACAO", convidados: 110 },
    (somente) => (somente === "salao-pequeno" ? [] : [{ id: "salao-grande" }]));
  const r = await escolherSalaoDestinoRevisao(b as unknown as DbExecutor, "rev");
  assert.deepEqual(r, { exigido: true, salao: "salao-grande", gravou: true });
  // S-E (R41-1): depois de gravar o salão do destino, o hash volta a ser o da função, num comando separado.
  const updates = b.executados.filter((e) => /^UPDATE fechamento_revisoes/.test(e.sql.trim()));
  assert.equal(updates.length, 2);
  assert.match(updates[0].sql, /SET salao_id = \$2::uuid/);
  assert.match(updates[1].sql, /conteudo_hash = kidmais_hash_revisao_operacional\(id\), revisao = revisao \+ 1/);
  assert.match(updates[1].sql, /estado = 'EM_ELABORACAO'/);
  const selecao = b.executados.find((e) => /FROM fechamento_revisoes r JOIN fechamentos f/.test(e.sql))!;
  assert.match(selecao.sql, /r\.convidados/, "lê os convidados da revisão");
  const [mantido, automatico] = b.executados.filter((e) => /FROM agenda_saloes s/.test(e.sql));
  assert.match(mantido.sql, ESTRITO, "sem fallback para quem não comporta");
  assert.equal(mantido.params[9], "salao-pequeno", "primeiro confere o salão já definido");
  assert.equal(mantido.params[8], 110, "convidados da revisão no $9");
  assert.equal(automatico.params[9], null, "depois, o menor que comporta");
  assert.match(automatico.sql, /ORDER BY s\.capacidade_convidados NULLS LAST, s\.ordem, s\.id/);
});

test("S-E: destino estrito — o definido fica se serve; sem nenhum que comporte, null; congelada só confere", async () => {
  const fica = banco({ ...comum, fechamento_id: "festa", salao_atual: "A", salao_destino: "B", estado: "EM_ELABORACAO", convidados: 50 },
    (somente) => (somente === "B" ? [{ id: "B" }] : [{ id: "C" }]));
  assert.deepEqual(await escolherSalaoDestinoRevisao(fica as unknown as DbExecutor, "rev"), { exigido: true, salao: "B" });
  assert.ok(!fica.executados.some((e) => /^\s*UPDATE/.test(e.sql)), "nada muda");
  // Exemplo do Astra: 50 → 120 convidados, A (máx. 80) não comporta; sem B livre, o destino fica sem salão (não conserva A).
  const nenhum = banco({ ...comum, fechamento_id: "festa", salao_atual: "A", salao_destino: "A", estado: "EM_ELABORACAO", convidados: 120 }, () => []);
  assert.deepEqual(await escolherSalaoDestinoRevisao(nenhum as unknown as DbExecutor, "rev"), { exigido: true, salao: null, gravou: true });
  const congelada = banco({ ...comum, fechamento_id: "festa", salao_atual: "A", salao_destino: "A", estado: "CONGELADA", convidados: 120 },
    (somente) => (somente === "A" ? [] : [{ id: "B" }]));
  assert.deepEqual(await escolherSalaoDestinoRevisao(congelada as unknown as DbExecutor, "rev"), { exigido: true, salao: null }, "congelada não troca: A não serve → indisponível");
  assert.ok(!congelada.executados.some((e) => /^\s*UPDATE/.test(e.sql)));
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
