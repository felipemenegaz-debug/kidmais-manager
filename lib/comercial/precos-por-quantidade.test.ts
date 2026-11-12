import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DbExecutor, DbQueryResult } from "../db/contracts.ts";
import { centavosPorPontos, pontosDeFaixas, validarPontos } from "./modelo-preco.ts";
import { gravarFaixasPacote, lerFaixasPacote } from "./pacote-precos.ts";

// Preço por quantidades cheias (092, decisão de Felipe em 22/10/2026).
const limites = { minimo: 50, maximo: 100 };
const pontos = [
  { convidados: 50, valor: "4.500,00" },
  { convidados: 60, valor: "4900" },
  { convidados: 70, valor: "5300.00" },
  { convidados: 80, valor: "5700" },
  { convidados: 90, valor: "6100" },
  { convidados: 100, valor: "6500" },
];
const raiz = dirname(fileURLToPath(import.meta.url));

test("quantidades cheias: ordem, extremos do pacote e preço igual ou maior que o anterior", () => {
  const prontos = validarPontos([...pontos].reverse(), limites);
  assert.deepEqual(prontos.map((p) => p.convidados), [50, 60, 70, 80, 90, 100]);
  assert.equal(prontos[0]?.valor, "4500.00");
  assert.deepEqual(validarPontos([], limites), []);
  assert.throws(() => validarPontos([{ convidados: 60, valor: "10" }, { convidados: 100, valor: "20" }], limites), /primeira quantidade precisa ser 50/);
  assert.throws(() => validarPontos([{ convidados: 50, valor: "10" }, { convidados: 90, valor: "20" }], limites), /última 100/);
  assert.throws(() => validarPontos([{ convidados: 50, valor: "10" }, { convidados: 50, valor: "20" }, { convidados: 100, valor: "30" }], limites), /mais de uma vez/);
  assert.throws(() => validarPontos([{ convidados: 40, valor: "10" }, { convidados: 100, valor: "20" }], limites), /entre o mínimo e o máximo/);
  assert.throws(
    () => validarPontos([{ convidados: 50, valor: "4500" }, { convidados: 60, valor: "4400" }, { convidados: 100, valor: "6500" }], limites),
    /O preço de 60 convidados precisa ser igual ou maior que o de 50 convidados \(R\$\s4\.500,00\)/,
  );
  assert.equal(validarPontos([{ convidados: 50, valor: "4500" }, { convidados: 100, valor: "4500" }], limites).length, 2);
  assert.throws(() => validarPontos([{ convidados: 50, valor: "0" }, { convidados: 100, valor: "1" }], limites), /preço/);
});

test("quantidade quebrada: diferença até a próxima dividida pelos convidados entre as duas", () => {
  const prontos = validarPontos(pontos, limites);
  assert.equal(centavosPorPontos(prontos, 50)?.centavos, 450000);
  assert.equal(centavosPorPontos(prontos, 53)?.centavos, 462000);
  assert.equal(centavosPorPontos(prontos, 59)?.centavos, 486000);
  assert.equal(centavosPorPontos(prontos, 60)?.centavos, 490000);
  assert.equal(centavosPorPontos(prontos, 100)?.centavos, 650000);
  assert.equal(centavosPorPontos(prontos, 49), null);
  assert.equal(centavosPorPontos(prontos, 101), null);
  const ancora = centavosPorPontos(prontos, 53);
  assert.deepEqual([ancora?.inferior.convidados, ancora?.superior.convidados], [50, 60]);
  // Passo irregular e arredondamento só no fim (meio centavo para cima): 100,00 → 100,01 em 3 convidados.
  const irregular = [{ convidados: 50, valor: "100.00" }, { convidados: 53, valor: "100.01" }];
  assert.equal(centavosPorPontos(irregular, 51)?.centavos, 10000);
  assert.equal(centavosPorPontos(irregular, 52)?.centavos, 10001);
});

test("conversão das faixas antigas: começo de cada faixa e o máximo com o preço da última", () => {
  const faixas = [
    { convidadosMin: 50, convidadosMax: 59, valor: "4500.00" },
    { convidadosMin: 60, convidadosMax: 69, valor: "4900.00" },
    { convidadosMin: 90, convidadosMax: 100, valor: "6100.00" },
  ];
  assert.deepEqual(pontosDeFaixas(faixas, limites), [
    { convidados: 50, valor: "4500.00" },
    { convidados: 60, valor: "4900.00" },
    { convidados: 90, valor: "6100.00" },
    { convidados: 100, valor: "6100.00" },
  ]);
  assert.deepEqual(pontosDeFaixas([{ convidadosMin: 50, convidadosMax: 100, valor: "10.00" }], limites).map((p) => p.convidados), [50, 100]);
});

function vazio<Row extends object>(): DbQueryResult<Row> {
  return { rows: [], rowCount: 0 };
}
function um<Row extends object>(row: Row): DbQueryResult<Row> {
  return { rows: [row], rowCount: 1 };
}

const empresa = "11111111-1111-4111-8111-111111111111";
const pacote = "22222222-2222-4222-8222-222222222222";
const ctx = { empresaId: empresa, usuarioId: "usuario-1", requestId: "req-1" };
const fixa = { tabela_id: "corrente", publicada: true, convidados_min: 50, convidados_max: 100, tipo_calculo: "FIXO", valor: "4500.00", categoria_horario: "GERAL" };

test("faixas antigas ficam a confirmar com proposta; pontos voltam como pontos", async () => {
  const leitura = (linhas: object[]): DbExecutor => ({ async query<Row extends object>(text: string): Promise<DbQueryResult<Row>> {
    if (text.includes("FROM precos_pacote pp")) return { rows: linhas as Row[], rowCount: linhas.length };
    if (text.includes("AS publicada")) return um({ id: "corrente", publicada: true } as Row);
    throw new Error(text);
  } });
  const antiga = await lerFaixasPacote(leitura([fixa]), empresa, pacote, limites);
  assert.equal(antiga.aConfirmar, true);
  assert.deepEqual(antiga.proposta?.map((p) => p.convidados), [50, 100]);
  const nova = await lerFaixasPacote(leitura([
    { ...fixa, tipo_calculo: "PONTO", convidados_min: 50, convidados_max: 50 },
    { ...fixa, tipo_calculo: "PONTO", convidados_min: 100, convidados_max: 100, valor: "6500.00" },
  ]), empresa, pacote, limites);
  assert.equal(nova.aConfirmar, false);
  assert.equal(nova.editavel, true);
  assert.deepEqual(nova.pontos, [{ convidados: 50, valor: "4500.00" }, { convidados: 100, valor: "6500.00" }]);
});

test("confirmar a conversão grava PONTO com mínimo = máximo, escopo sem cobertura contínua e auditoria própria", async () => {
  const sqls: Array<{ text: string; values: readonly unknown[] }> = [];
  const tx: DbExecutor = { async query<Row extends object>(text: string, values?: readonly unknown[]): Promise<DbQueryResult<Row>> {
    sqls.push({ text, values: values ?? [] });
    if (text.includes("UPDATE precos_pacote")) throw new Error(`escrita proibida: ${text}`);
    if (text.includes("kidmais_037_trava_publicacao") || text.includes("kidmais_047_lacunas_escopo") || text.includes("pg_advisory_xact_lock")) return vazio();
    if (text.includes("FROM precos_pacote pp")) return um(fixa as Row);
    if (text.includes("FOR UPDATE")) return um({ id: "corrente" } as Row);
    if (text.includes("AS publicada")) return um({ id: "corrente", publicada: true } as Row);
    if (text.startsWith("INSERT INTO tabelas_preco")) return um({ id: "nova" } as Row);
    if (text.includes("substituida_em = clock_timestamp()")) return um({ id: "corrente" } as Row);
    if (text.includes("SET publicada_em = clock_timestamp()")) return um({ id: "nova" } as Row);
    if (text.includes("count(*)::int AS n")) return um({ n: 1 } as Row);
    if (text.startsWith("INSERT") || text.startsWith("DELETE") || text.startsWith("WITH")) return um({ id: "escopo-1" } as Row);
    throw new Error(text);
  } };
  await gravarFaixasPacote(tx, empresa, pacote, {
    pontos: [{ convidados: 50, valor: "4500" }, { convidados: 100, valor: "6500" }],
    conversao: true,
  }, limites, ctx);
  const pontosGravados = sqls.filter((s) => s.text.includes("INSERT INTO precos_pacote") && s.text.includes("'PONTO'"));
  assert.equal(pontosGravados.length, 2);
  assert.match(pontosGravados[0]?.text ?? "", /\$3, \$3, 'PONTO'/);
  assert.deepEqual(pontosGravados.map((s) => s.values[2]), [50, 100]);
  const escopo = sqls.find((s) => s.text.includes("INSERT INTO tabela_preco_escopos") && s.text.includes("VALUES"));
  assert.match(escopo?.text ?? "", /'GERAL', false, NULL, NULL/);
  const auditoria = sqls.find((s) => s.text.includes("INSERT INTO auditoria"));
  assert.equal(auditoria?.values.includes("PRECO_PACOTE_CONVERTIDO"), true);
  // Decrescente é recusado antes de qualquer escrita.
  sqls.length = 0;
  await assert.rejects(
    gravarFaixasPacote(tx, empresa, pacote, { pontos: [{ convidados: 50, valor: "4500" }, { convidados: 100, valor: "4000" }] }, limites, ctx),
    /igual ou maior/,
  );
  assert.equal(sqls.some((s) => s.text.startsWith("INSERT")), false);
});

test("o cálculo da festa e a migration usam o mesmo ponto: PONTO aceito, extremos e ordem conferidos na publicação", () => {
  const repo = readFileSync(resolve(raiz, "repositories/comercial.repository.ts"), "utf8");
  assert.match(repo, /tipo_calculo = 'PONTO'/);
  assert.match(repo, /centavosPorPontos/);
  const sql = readFileSync(resolve(raiz, "../../database/migrations/20261022_092_precos_por_quantidade.sql"), "utf8");
  for (const lacuna of ["PONTO_MISTURADO", "PONTO_SEM_EXTREMOS", "PONTO_DECRESCENTE"]) assert.match(sql, new RegExp(lacuna));
  assert.match(sql, /tipo_calculo <> 'PONTO' OR convidados_max = convidados_min/);
  assert.match(sql, /'FIXO', 'POR_CONVIDADO', 'PONTO'/);
});
