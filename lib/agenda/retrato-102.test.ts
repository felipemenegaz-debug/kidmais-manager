import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Parecer do Astra (26/10/2026, P2-3): o retrato semântico da 102 tem UMA fonte (database/checks/20261025_102_retrato.sql)
 * e é embutido, idêntico, no postcheck, na integridade e no rollback; o hash esperado é o mesmo nos três.
 */
const ler = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const trecho = (texto: string) => {
  const i = texto.indexOf("-- RETRATO_102_INICIO");
  const j = texto.indexOf("-- RETRATO_102_FIM");
  assert.ok(i >= 0 && j > i, "marcadores do retrato presentes");
  assert.equal(texto.indexOf("-- RETRATO_102_INICIO", i + 1), -1, "um único retrato por arquivo");
  return texto.slice(i, j);
};
const FONTE = "database/checks/20261025_102_retrato.sql";
const EMBUTIDOS = ["database/checks/20261025_102_postcheck.sql", "database/checks/20261025_102_integridade.sql", "database/rollback/20261025_102_saloes_apresentacao_down.sql"];

test("retrato 102: o trecho embutido no postcheck, na integridade e no rollback é idêntico à fonte", () => {
  const fonte = trecho(ler(FONTE));
  for (const arquivo of EMBUTIDOS) assert.equal(trecho(ler(arquivo)), fonte, arquivo);
});

test("retrato 102: o mesmo hash esperado (64 hex) nos três arquivos; nenhum marcador pendente", () => {
  const hashes = EMBUTIDOS.map((arquivo) => {
    const texto = ler(arquivo);
    assert.doesNotMatch(texto, /RETRATO_102_HASH_PENDENTE/, arquivo);
    const m = /-- RETRATO_102_FIM\n\s*\) (?:IS DISTINCT FROM|=) '([0-9a-f]{64})'/.exec(texto);
    assert.ok(m, `hash esperado em ${arquivo}`);
    return m[1];
  });
  assert.equal(new Set(hashes).size, 1, hashes.join(" "));
});

test("retrato 102: cobre definição completa, não só nome/contagem", () => {
  const fonte = trecho(ler(FONTE));
  for (const parte of ["pg_get_constraintdef", "pg_get_indexdef", "pg_get_triggerdef", "proconfig", "prosecdef", "provolatile", "indisunique",
    "tgenabled", "attnotnull", "pg_get_expr", "agenda_salao_itens_catalogo x"]) {
    assert.ok(fonte.includes(parte), parte);
  }
});
