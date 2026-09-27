/* eslint-disable @typescript-eslint/no-require-imports */
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  listarTestesPostgres,
  exigirOptInDescartavel,
  exigirListaPostgres,
} = require("./regressao-v1-selecao.cjs");

const raiz = path.resolve(__dirname, "..");

function recusar(erro) {
  console.error(erro instanceof Error ? erro.message : String(erro));
  process.exit(1);
}

let testes;
try {
  exigirOptInDescartavel(process.env);
  testes = exigirListaPostgres(listarTestesPostgres(raiz));
} catch (erro) {
  recusar(erro);
}

console.log(`\n=== PostgreSQL descartável (${testes.length} arquivos) ===`);
const env = { ...process.env, NEXT_TELEMETRY_DISABLED: "1" };
delete env.DATABASE_URL;

const resultado = spawnSync(
  process.execPath,
  ["--experimental-strip-types", "--test", ...testes],
  { cwd: raiz, env, stdio: "inherit" },
);
if (resultado.error) throw resultado.error;
if (resultado.status !== 0) process.exit(resultado.status ?? 1);

console.log("\nPASS suíte PostgreSQL descartável.");
