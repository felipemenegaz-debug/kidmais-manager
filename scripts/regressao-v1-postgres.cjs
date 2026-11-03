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
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const guardaSalao = require("./guarda-salao-harness.cjs");
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

/**
 * Ambiente da suíte: explícito (ambienteDaSuite); o alvo da 054 só para a suíte que o declara. Liberar agenda com mais de
 * um salão (rev. 6–7): o preload da guarda dinâmica entra por NODE_OPTIONS (também nos subprocessos) e grava o registro
 * da suíte em `registro`.
 */
function ambiente(estado, porta, banco, registro) {
  // Barras normais: no NODE_OPTIONS a barra invertida é tratada como escape (o caminho tem espaços e vai entre aspas).
  const preload = path.join(__dirname, "guarda-salao-preload.cjs").replace(/\\/g, "/");
  const base = ambienteDaSuite(process.env, estado, porta, banco);
  return { ...base, NODE_OPTIONS: `${base.NODE_OPTIONS ?? ""} --require "${preload}"`.trim(), KIDMAIS_GUARDA_SALAO_ARQUIVO: registro };
}
const PASTA_GUARDA = fs.mkdtempSync(path.join(os.tmpdir(), "kidmais-guarda-salao-"));

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
  const ordensDeTeste = [];
  const ordensDeAplicador = [];
  const escritas = [];
  const ordensOk = new Map();
  const semGuardaAplicada = [];
  try {
    const modelos = [...new Set(planos.flatMap((p) => [p.estado.descartavel, p.estado.rollback].filter(Boolean)))];
    for (const modelo of modelos) await receita.construirModelo(admin, porta, modelo);
    for (const { arquivo, estado } of planos) {
      for (const banco of receita.TRABALHO) await receita.removerBanco(admin, banco);
      await receita.restaurar(admin, trabalho, estado.descartavel);
      if (estado.rollback) await receita.restaurar(admin, "kidmais_pacotes_v1_rollback", estado.rollback);
      // Guarda dinâmica (só no cluster descartável): gatilhos kidmais_teste_* nos bancos de trabalho desta suíte, não no
      // modelo, para que `semGuardaSalao` (suítes que comparam o retrato do catálogo com o staging) valha só para ela.
      const semGuarda = estado.semGuardaSalao?.modelos.includes(estado.descartavel) ? estado.semGuardaSalao.motivo : null;
      if (semGuarda) {
        console.log(`guarda de escritores de salão NÃO instalada nesta suíte: ${semGuarda}`);
        semGuardaAplicada.push({ suite: estado.relativo, modelo: estado.descartavel, motivo: semGuarda });
      } else {
        for (const banco of [trabalho, ...(estado.rollback ? ["kidmais_pacotes_v1_rollback"] : [])]) {
          const cliente = await receita.conectar(porta, banco);
          try { await guardaSalao.instalar(cliente); } finally { await cliente.end(); }
        }
      }
      const descricao = `${estado.relativo} [${estado.descartavel}${estado.rollback ? ` + ${estado.rollback}` : ""}]`;
      console.log(`\n--- ${descricao}`);
      const inicio = Date.now();
      const registro = path.join(PASTA_GUARDA, `${resultados.length}.jsonl`);
      const r = spawnSync(process.execPath, ["--experimental-strip-types", "--test", arquivo], {
        cwd: raiz,
        env: ambiente(estado, porta, trabalho, registro),
        stdio: "inherit",
        timeout: LIMITE_POR_SUITE_MS,
      });
      const abertas = await conexoesDeTrabalho(admin, receita.TRABALHO);
      const eventos = guardaSalao.lerRegistro(registro);
      const problemas = eventos.some((e) => e.tipo === "PRELOAD") ? guardaSalao.avaliar(eventos) : ["registro da guarda ausente (preload não carregou)"];
      for (const p of problemas) console.error(`GUARDA ${estado.relativo}: ${p}`);
      // Rodada 3: ordens de aplicador de migration anterior à 114 (auditadas no preload) ficam numa lista à parte.
      ordensDeTeste.push(...eventos.filter((e) => e.tipo === "ORDEM" && !e.producao && e.emissor !== "APLICADOR_MIGRACAO").map((e) => ({ suite: estado.relativo, ...e })));
      ordensDeAplicador.push(...eventos.filter((e) => e.tipo === "ORDEM" && e.emissor === "APLICADOR_MIGRACAO").map((e) => ({ suite: estado.relativo, ...e })));
      for (const e of eventos.filter((x) => x.tipo === "ORDEM_OK")) {
        const k = e.quadros.join(" < ") || "(sem quadro de produção)";
        const atual = ordensOk.get(k) ?? { n: 0, suites: new Set() };
        atual.n += 1; atual.suites.add(estado.relativo); ordensOk.set(k, atual);
      }
      escritas.push(...eventos.filter((e) => e.tipo === "ESCRITA").map((e) => ({ suite: estado.relativo, marca: e.marca.replace(/:[0-9a-f]{32}$/, ""), tabela: e.tabela, valor: e.valor })));
      const situacao = r.error?.code === "ETIMEDOUT" ? "NÃO TERMINOU NO LIMITE" : r.error ? `ERRO ${r.error.code ?? r.error.message}` : r.status !== 0 ? "FALHOU" : abertas ? `DEIXOU ${abertas} CONEXÃO(ÕES) ABERTA(S)` : problemas.length ? `GUARDA: ${problemas.length} violação(ões)` : "OK";
      resultados.push({ descricao, situacao, segundos: Math.round((Date.now() - inicio) / 1000) });
    }
  } finally {
    await admin.end();
  }
  // Fase 0: o que a guarda viu (escritas por marca; ordens fora do padrão originadas no próprio teste), para o pacote.
  const contagem = new Map();
  for (const e of escritas) { const k = `${e.marca} → ${e.tabela} (${e.valor})`; contagem.set(k, (contagem.get(k) ?? 0) + 1); }
  const relatorio = { escritas: Object.fromEntries([...contagem].sort()), ordensDeTeste, ordensDeAplicador, semGuardaSalao: semGuardaAplicada,
    ordensOk: Object.fromEntries([...ordensOk].sort().map(([k, v]) => [k, { n: v.n, suites: [...v.suites].sort() }])) };
  const destino = process.env.KIDMAIS_GUARDA_RELATORIO ?? path.join(PASTA_GUARDA, "relatorio.json");
  fs.writeFileSync(destino, JSON.stringify(relatorio, null, 1));
  console.log(`guarda de escritores de salão: ${escritas.length} escritas marcadas, ${ordensDeTeste.length} ordens fora do padrão em código de teste, ${ordensDeAplicador.length} de aplicador de migration anterior à 114; relatório ${destino}`);
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
