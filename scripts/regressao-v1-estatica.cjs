/* eslint-disable @typescript-eslint/no-require-imports */
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { arquivosDoCheckEstatico } = require("./regressao-v1-selecao.cjs");

const raiz = path.resolve(__dirname, "..");

// Travas de produto lidas de process.env não podem mudar o resultado dos testes: o build do Render roda este check com
// as variáveis do serviço. Com ASSINATURA_AVISOS_EMAIL=ligado no web, testes com banco simulado passavam a executar o
// gancho dos avisos (SAVEPOINT não modelado) e o build falhava (03/11/2026). Os testes dos avisos passam a trava
// explicitamente; aqui ela é sempre removida.
const TRAVAS_FORA_DOS_TESTES = Object.freeze(["ASSINATURA_AVISOS_EMAIL"]);
function ambienteDosTestes(base = process.env) {
  const env = { ...base, NEXT_TELEMETRY_DISABLED: "1" };
  for (const chave of TRAVAS_FORA_DOS_TESTES) delete env[chave];
  return env;
}

function executar(nome, argumentos) {
  console.log(`\n=== ${nome} ===`);
  const resultado = spawnSync(process.execPath, argumentos, {
    cwd: raiz,
    env: ambienteDosTestes(),
    stdio: "inherit",
  });
  if (resultado.error) throw resultado.error;
  if (resultado.status !== 0) process.exit(resultado.status ?? 1);
}

// O filho já usa a raiz como cwd. Caminhos relativos evitam ENAMETOOLONG em worktrees Windows profundas.
const testes = arquivosDoCheckEstatico(raiz).map(arquivo => path.relative(raiz, arquivo));

executar("Worker de PDF atualizado", ["scripts/gerar-pdf-worker.cjs", "--check"]);

executar("Testes unitários V1", ["--experimental-strip-types", "--test", ...testes]);
executar("Harness staging — somente mocks, sem rede/banco", ["--test", "scripts/staging-smoke/smoke.test.mjs"]);
executar("Lint", [
  path.join(path.dirname(require.resolve("eslint/package.json")), "bin", "eslint.js"),
  ".",
]);
executar("TypeScript", [require.resolve("typescript/lib/tsc.js"), "--noEmit"]);
executar("Build de produção", [require.resolve("next/dist/bin/next"), "build"]);
executar("Leitura de PDF no asset de produção", ["scripts/verificar-pdf-worker-build.cjs"]);

console.log("\nPASS regressão estática V1: testes, lint, TypeScript e build aprovados.");
