/* eslint-disable @typescript-eslint/no-require-imports */
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { arquivosDoCheckEstatico } = require("./regressao-v1-selecao.cjs");

const raiz = path.resolve(__dirname, "..");

function executar(nome, argumentos) {
  console.log(`\n=== ${nome} ===`);
  const resultado = spawnSync(process.execPath, argumentos, {
    cwd: raiz,
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
    stdio: "inherit",
  });
  if (resultado.error) throw resultado.error;
  if (resultado.status !== 0) process.exit(resultado.status ?? 1);
}

const testes = arquivosDoCheckEstatico(raiz);

executar("Testes unitários V1", ["--experimental-strip-types", "--test", ...testes]);
executar("Harness staging — somente mocks, sem rede/banco", ["--test", "scripts/staging-smoke/smoke.test.mjs"]);
executar("Lint", [
  path.join(path.dirname(require.resolve("eslint/package.json")), "bin", "eslint.js"),
  ".",
]);
executar("TypeScript", [require.resolve("typescript/lib/tsc.js"), "--noEmit"]);
executar("Build de produção", [require.resolve("next/dist/bin/next"), "build"]);

console.log("\nPASS regressão estática V1: testes, lint, TypeScript e build aprovados.");
