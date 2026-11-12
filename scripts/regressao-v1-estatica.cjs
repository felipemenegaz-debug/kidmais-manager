/* eslint-disable @typescript-eslint/no-require-imports */
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { arquivosDoCheckEstatico } = require("./regressao-v1-selecao.cjs");

const raiz = path.resolve(__dirname, "..");

// Travas de produto lidas de process.env não podem mudar o resultado dos testes: o build do Render roda este check com
// as variáveis do serviço. Com ASSINATURA_AVISOS_EMAIL=ligado no web, testes com banco simulado passavam a executar o
// gancho dos avisos (SAVEPOINT não modelado) e o build falhava (03/11/2026). Os testes dos avisos passam a trava
// explicitamente; aqui ela é sempre removida.
// IDENTIDADE_OTP_EMAIL_RESERVA (12/11/2026): ligada no web, mudaria os canais e o health nos testes da identidade.
const TRAVAS_FORA_DOS_TESTES = Object.freeze(["ASSINATURA_AVISOS_EMAIL", "IDENTIDADE_OTP_EMAIL_RESERVA"]);
// A identidade do deploy também fica fora dos testes. A trava de cobrança (lib/assinatura/trava-cobranca.ts) fecha
// quando RENDER_SERVICE_ID é o web de production ou KIDMAIS_DEPLOY_ENV=production; no build de production, testes que
// exercitam a cobrança com banco simulado recebiam COBRANCA_TRAVADA e o deploy dep-dbqtpqmtlv9c739hcr4g falhou
// (12/11/2026). Os testes da trava passam o ambiente explicitamente. Só os testes perdem essas chaves; o build não.
const IDENTIDADE_DO_DEPLOY = Object.freeze(["RENDER", "RENDER_SERVICE_ID", "KIDMAIS_DEPLOY_ENV"]);
function ambienteDosTestes(base = process.env, { semIdentidadeDoDeploy = false } = {}) {
  const env = { ...base, NEXT_TELEMETRY_DISABLED: "1" };
  for (const chave of TRAVAS_FORA_DOS_TESTES) delete env[chave];
  if (semIdentidadeDoDeploy) for (const chave of IDENTIDADE_DO_DEPLOY) delete env[chave];
  return env;
}

function executar(nome, argumentos, opcoes = {}) {
  console.log(`\n=== ${nome} ===`);
  const resultado = spawnSync(process.execPath, argumentos, {
    cwd: raiz,
    env: ambienteDosTestes(process.env, opcoes),
    stdio: "inherit",
  });
  if (resultado.error) throw resultado.error;
  if (resultado.status !== 0) process.exit(resultado.status ?? 1);
}

// O filho já usa a raiz como cwd. Caminhos relativos evitam ENAMETOOLONG em worktrees Windows profundas.
const testes = arquivosDoCheckEstatico(raiz).map(arquivo => path.relative(raiz, arquivo));

executar("Worker de PDF atualizado", ["scripts/gerar-pdf-worker.cjs", "--check"]);

executar("Testes unitários V1", ["--experimental-strip-types", "--test", ...testes], { semIdentidadeDoDeploy: true });
executar("Harness staging — somente mocks, sem rede/banco", ["--test", "scripts/staging-smoke/smoke.test.mjs"], { semIdentidadeDoDeploy: true });
executar("Lint", [
  path.join(path.dirname(require.resolve("eslint/package.json")), "bin", "eslint.js"),
  ".",
]);
executar("TypeScript", [require.resolve("typescript/lib/tsc.js"), "--noEmit"]);
executar("Build de produção", [require.resolve("next/dist/bin/next"), "build"]);
executar("Leitura de PDF no asset de produção", ["scripts/verificar-pdf-worker-build.cjs"]);

console.log("\nPASS regressão estática V1: testes, lint, TypeScript e build aprovados.");
