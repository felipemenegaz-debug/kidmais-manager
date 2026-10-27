import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * S-E (plano rev. 4.1, R41-1/R41-T): só lib/agenda/salao-festa.ts grava fechamento_revisoes.salao_id, e cada gravação é
 * seguida, no mesmo bloco, do recálculo do hash pela função do banco (recalcularHashRevisao). Teste estático.
 */
const raiz = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
function arquivos(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === "node_modules" || n.startsWith(".") ? [] : arquivos(p);
    return /\.(ts|tsx|cjs|mjs)$/.test(n) && !/\.test\.|test-apoio|test-support/.test(n) ? [p] : [];
  });
}
const GRAVA = /UPDATE\s+fechamento_revisoes\s+SET\s+salao_id/i;

test("R41-1: único ponto que grava o salão do destino da revisão, sempre seguido do recálculo do hash", () => {
  const gravam = [...arquivos(join(raiz, "lib")), ...arquivos(join(raiz, "app"))].filter((p) => GRAVA.test(readFileSync(p, "utf8")));
  assert.deepEqual(gravam.map((p) => relative(raiz, p).replaceAll("\\", "/")), ["lib/agenda/salao-festa.ts"]);
  const fonte = readFileSync(join(raiz, "lib/agenda/salao-festa.ts"), "utf8");
  const pontos = [...fonte.matchAll(new RegExp(GRAVA.source, "gi"))].map((m) => m.index!);
  assert.equal(pontos.length, 2, "seletor do destino e escolha explícita da equipe");
  for (const i of pontos) {
    const seguinte = fonte.slice(i, i + 400);
    assert.match(seguinte, /await recalcularHashRevisao\(tx, revisaoId\);/, "recálculo logo depois da gravação");
  }
});
