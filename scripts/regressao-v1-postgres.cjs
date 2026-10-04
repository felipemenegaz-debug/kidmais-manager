/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * check:v1:postgres (D3) — suítes `*.postgres.test.ts` no cluster descartável, de forma reproduzível:
 *   1. opt-in explícito e lista de suítes (sem opt-in: recusa antes de qualquer conexão);
 *   2. cada suíte declara o estado de que precisa (regressao-v1-selecao.cjs: ESTADO_POSTGRES);
 *   3. a receita (regressao-v1-postgres-receita.cjs) prova a identidade do cluster e recria, do schema vazio,
 *      os modelos desses estados;
 *   4. uma suíte por vez: os bancos de trabalho são removidos e restaurados do modelo declarado, a suíte roda
 *      isolada e, ao terminar, não pode deixar conexão aberta; suíte que não termina no limite falha.
 * DATABASE_URL e PG* nunca participam; a porta segue a mesma autorização literal das suítes.
 */
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  listarTestesPostgres,
  exigirOptInDescartavel,
  exigirListaPostgres,
  estadoDaSuite,
  ambienteDaSuite,
  filtrarSuites,
  variavelDeConexaoHerdada,
} = require("./regressao-v1-selecao.cjs");

// Antes de qualquer conexão (inclusive a da receita, neste processo): nenhuma configuração herdada do driver.
for (const nome of Object.keys(process.env)) if (variavelDeConexaoHerdada(nome)) delete process.env[nome];

const raiz = path.resolve(__dirname, "..");
const LIMITE_POR_SUITE_MS = 15 * 60 * 1000;

function recusar(erro) {
  console.error(erro instanceof Error ? erro.message : String(erro));
  process.exit(1);
}

let planos;
try {
  exigirOptInDescartavel(process.env);
  // Uma execução por estado: o declarado e, quando houver, os de `tambem` (mesma suíte em outra etapa do schema).
  planos = filtrarSuites(exigirListaPostgres(listarTestesPostgres(raiz)).flatMap((arquivo) => {
    const estado = estadoDaSuite(raiz, arquivo);
    return [estado, ...(estado.tambem ?? []).map((modelo) => ({ ...estado, descartavel: modelo }))].map((e) => ({ arquivo, estado: e }));
  }), process.env);
} catch (erro) {
  recusar(erro);
}

/** Ambiente da suíte: explícito (ambienteDaSuite); o alvo da 054 só para a suíte que o declara. */
function ambiente(estado, porta, banco) {
  return ambienteDaSuite(process.env, estado, porta, banco);
}

async function conexoesDeTrabalho(admin, bancos) {
  for (let tentativa = 0; tentativa < 40; tentativa++) {
    const r = await admin.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = ANY($1::text[]) AND pid <> pg_backend_pid()", [bancos]);
    if (r.rows[0].n === 0) return 0;
    await new Promise((fim) => setTimeout(fim, 50));
  }
  return (await admin.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = ANY($1::text[])", [bancos])).rows[0].n;
}

async function principal() {
  const receita = require("./regressao-v1-postgres-receita.cjs");
  const [trabalho] = receita.TRABALHO;
  console.log(`\n=== PostgreSQL descartável (${planos.length} arquivos) ===`);
  const { porta, admin } = await receita.conectarAdmin(process.env);
  const resultados = [];
  try {
    const modelos = [...new Set(planos.flatMap((p) => [p.estado.descartavel, p.estado.rollback].filter(Boolean)))];
    for (const modelo of modelos) {
      await receita.construirModelo(admin, porta, modelo);
      console.log(`receita: modelo ${modelo} recriado do schema vazio`);
    }
    for (const { arquivo, estado } of planos) {
      for (const banco of receita.TRABALHO) await receita.removerBanco(admin, banco);
      await receita.restaurar(admin, trabalho, estado.descartavel);
      if (estado.rollback) await receita.restaurar(admin, "kidmais_pacotes_v1_rollback", estado.rollback);
      const descricao = `${estado.relativo} [${estado.descartavel}${estado.rollback ? ` + ${estado.rollback}` : ""}]`;
      console.log(`\n--- ${descricao}`);
      const inicio = Date.now();
      const r = spawnSync(process.execPath, ["--experimental-strip-types", "--test", arquivo], {
        cwd: raiz,
        env: ambiente(estado, porta, trabalho),
        stdio: "inherit",
        timeout: LIMITE_POR_SUITE_MS,
      });
      const abertas = await conexoesDeTrabalho(admin, receita.TRABALHO);
      const situacao = r.error?.code === "ETIMEDOUT" ? "NÃO TERMINOU NO LIMITE" : r.error ? `ERRO ${r.error.code ?? r.error.message}` : r.status !== 0 ? "FALHOU" : abertas ? `DEIXOU ${abertas} CONEXÃO(ÕES) ABERTA(S)` : "OK";
      resultados.push({ descricao, situacao, segundos: Math.round((Date.now() - inicio) / 1000) });
    }
  } finally {
    await admin.end();
  }
  console.log("\n=== Resumo PostgreSQL descartável ===");
  for (const r of resultados) console.log(`${r.situacao === "OK" ? "ok  " : "FALHA"} ${r.descricao} — ${r.situacao} (${r.segundos}s)`);
  const falhas = resultados.filter((r) => r.situacao !== "OK");
  if (falhas.length) {
    console.error(`\nFALHA suíte PostgreSQL descartável: ${falhas.length} de ${resultados.length} arquivos.`);
    process.exit(1);
  }
  console.log(`\nPASS suíte PostgreSQL descartável: ${resultados.length} arquivos, cada um no estado declarado.`);
}

principal().catch(recusar);
