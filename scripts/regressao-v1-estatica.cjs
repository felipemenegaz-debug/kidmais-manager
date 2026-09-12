/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const raiz = path.resolve(__dirname, "..");

function arquivosTeste(diretorio) {
  const encontrados = [];
  for (const item of fs.readdirSync(diretorio, { withFileTypes: true })) {
    const caminho = path.join(diretorio, item.name);
    if (item.isDirectory()) encontrados.push(...arquivosTeste(caminho));
    else if (item.name.endsWith(".test.ts")) encontrados.push(caminho);
  }
  return encontrados;
}

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

const testes = ["app", "components", "lib"]
  .flatMap((pasta) => arquivosTeste(path.join(raiz, pasta)))
  .sort();

executar("Testes unitários V1", ["--experimental-strip-types", "--test", ...testes]);
executar("Lint", [
  path.join(path.dirname(require.resolve("eslint/package.json")), "bin", "eslint.js"),
  ".",
]);
executar("TypeScript", [require.resolve("typescript/lib/tsc.js"), "--noEmit"]);
executar("Build de produção", [require.resolve("next/dist/bin/next"), "build"]);

console.log("\nPASS regressão estática V1: testes, lint, TypeScript e build aprovados.");
