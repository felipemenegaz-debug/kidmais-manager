/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Ciclo do cluster PostgreSQL SINTÉTICO autorizado para as suítes da 061/062 — e nenhum outro alvo.
 *
 *   node scripts/pg-descartavel-061.cjs preparar   cria o cluster novo (só se o diretório NÃO existir e a porta
 *                                                  estiver livre), sobe e prova a identidade; divergência = para
 *                                                  o servidor que ele mesmo subiu e aborta
 *   node scripts/pg-descartavel-061.cjs provar     só prova a identidade do cluster em execução (somente leitura)
 *   node scripts/pg-descartavel-061.cjs executar  prova a identidade de novo e roda check:v1:postgres com
 *                                                  ambiente explícito (KIDMAIS_POSTGRES_SOMENTE repete suítes)
 *   node scripts/pg-descartavel-061.cjs encerrar   para o cluster DESTE diretório e confirma que parou
 *   node scripts/pg-descartavel-061.cjs limpar     valida caminho exato, ausência de junction/symlink e cluster
 *                                                  parado; só então remove o diretório
 *
 * Exige KIDMAIS_CLUSTER_061_AUTORIZACAO="<diretório>|127.0.0.1:55498|kidmais_descartavel" (literal). Nunca usa
 * DATABASE_URL, PG*, a porta 5432, o banco kidmais_manager nem o cluster perfil-v1-revisao. Relatórios (saída das
 * suítes, log do servidor, evidências) ficam FORA do diretório removido.
 */
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { variavelDeConexaoHerdada } = require("./regressao-v1-selecao.cjs");

const DIR = "D:\\glass\\KidMais Manager\\ambientes-locais\\pg-descartavel-061";
const PAI = "D:\\glass\\KidMais Manager\\ambientes-locais";
const RELATORIOS = "D:\\glass\\KidMais Manager\\ambientes-locais\\pg-descartavel-061-relatorios";
const BIN = "C:\\Program Files\\PostgreSQL\\18\\bin";
const HOST = "127.0.0.1";
const PORTA = 55498;
const PAPEL = "kidmais_descartavel";
const AUTORIZACAO = `${DIR}|${HOST}:${PORTA}|${PAPEL}`;
const raiz = path.resolve(__dirname, "..");

function falhar(motivo) {
  throw new Error(`cluster 061 recusado: ${motivo}`);
}

function registrar(nome, conteudo) {
  fs.mkdirSync(RELATORIOS, { recursive: true });
  const arquivo = path.join(RELATORIOS, `${new Date().toISOString().replace(/[:.]/g, "-")}-${nome}`);
  fs.writeFileSync(arquivo, typeof conteudo === "string" ? conteudo : JSON.stringify(conteudo, null, 2));
  return arquivo;
}

/** Ambiente dos processos do PostgreSQL e das suítes: sem nenhuma configuração de conexão herdada. */
function ambienteLimpo(extra = {}) {
  const env = { ...process.env };
  // Também qualquer *DATABASE_URL (ex.: KIDMAIS_HOMOLOGACAO_DATABASE_URL): nenhum destino herdado chega às suítes.
  for (const nome of Object.keys(env)) if (variavelDeConexaoHerdada(nome) || /DATABASE_URL$/i.test(nome)) delete env[nome];
  return { ...env, ...extra };
}

function exigirAutorizacao() {
  if (process.env.KIDMAIS_CLUSTER_061_AUTORIZACAO !== AUTORIZACAO) falhar(`defina KIDMAIS_CLUSTER_061_AUTORIZACAO=${AUTORIZACAO}`);
  for (const nome of Object.keys(process.env)) if (variavelDeConexaoHerdada(nome) || /DATABASE_URL$/i.test(nome)) delete process.env[nome];
}

/** Caminho exato, sem junction/symlink no diretório nem no pai. */
function exigirCaminhoReal(caminho, deveExistir) {
  if (path.resolve(caminho) !== caminho) falhar(`caminho não canônico: ${caminho}`);
  const real = fs.realpathSync.native(PAI);
  if (real.toLowerCase() !== PAI.toLowerCase()) falhar(`o diretório pai é redirecionado (${real})`);
  if (fs.lstatSync(PAI).isSymbolicLink()) falhar("o diretório pai é junction/symlink");
  if (!deveExistir) return;
  const st = fs.lstatSync(caminho);
  if (st.isSymbolicLink() || !st.isDirectory()) falhar(`${caminho} é junction/symlink ou não é diretório`);
  if (fs.realpathSync.native(caminho).toLowerCase() !== caminho.toLowerCase()) falhar(`${caminho} é redirecionado`);
}

function portaEmUso(host) {
  return new Promise((resolve) => {
    const servidor = net.createServer();
    servidor.once("error", (erro) => resolve(erro.code === "EADDRINUSE" || erro.code === "EACCES"));
    servidor.once("listening", () => servidor.close(() => resolve(false)));
    servidor.listen({ host, port: PORTA, exclusive: true });
  });
}

function alguemEscuta() {
  return new Promise((resolve) => {
    const s = net.connect({ host: HOST, port: PORTA });
    s.once("connect", () => { s.destroy(); resolve(true); });
    s.once("error", () => resolve(false));
    s.setTimeout(2000, () => { s.destroy(); resolve(false); });
  });
}

async function exigirPortaLivre() {
  if (await alguemEscuta()) falhar(`a porta ${PORTA} já tem servidor; nada é reutilizado nem encerrado`);
  if (await portaEmUso(HOST) || await portaEmUso("0.0.0.0")) falhar(`a porta ${PORTA} está ocupada; nada é reutilizado nem encerrado`);
}

function executarBinario(nome, args, opcoes = {}) {
  const r = spawnSync(path.join(BIN, nome), args, { env: ambienteLimpo(), encoding: "utf8", windowsHide: true, ...opcoes });
  if (r.error) throw r.error;
  return r;
}

/** Identidade completa; qualquer divergência INTERROMPE (lança). Conexão explícita, sem senha carregada. */
async function provarIdentidade() {
  const pg = require("pg");
  const client = new pg.Client({
    host: HOST, port: PORTA, user: PAPEL, database: "postgres", application_name: "kidmais-cluster-061",
    password: () => Promise.reject(new Error("o servidor pediu senha; nenhuma credencial é carregada")),
  });
  await client.connect();
  try {
    const r = await client.query(`SELECT current_setting('cluster_name') AS cluster, host(inet_server_addr()) AS addr, inet_server_port() AS port,
        current_user AS usuario, current_setting('data_directory') AS dir, current_setting('server_version_num')::int AS versao,
        EXISTS (SELECT 1 FROM pg_database WHERE lower(datname) = 'kidmais_manager') AS tem_real`);
    const id = r.rows[0];
    const esperado = { cluster: PAPEL, addr: HOST, port: PORTA, usuario: PAPEL, dir: DIR.toLowerCase(), tem_real: false };
    const obtido = { cluster: id.cluster, addr: id.addr, port: Number(id.port), usuario: id.usuario, dir: String(id.dir).replace(/\//g, "\\").toLowerCase(), tem_real: id.tem_real };
    if (JSON.stringify(obtido) !== JSON.stringify(esperado) || Math.floor(id.versao / 10000) !== 18) {
      falhar(`identidade divergente: ${JSON.stringify({ ...obtido, versao: id.versao })}`);
    }
    return { ...obtido, versao: id.versao };
  } finally {
    await client.end();
  }
}

function pararEsteCluster() {
  return executarBinario("pg_ctl.exe", ["-D", DIR, "stop", "-m", "fast", "-w"]);
}

async function preparar() {
  exigirAutorizacao();
  exigirCaminhoReal(DIR, false);
  if (fs.existsSync(DIR)) falhar(`${DIR} já existe; não é reutilizado`);
  await exigirPortaLivre();
  const init = executarBinario("initdb.exe", ["-D", DIR, "-U", PAPEL, "--auth=trust", "--encoding=UTF8", "--locale-provider=builtin", "--builtin-locale=C.UTF-8", "--locale=C"]);
  registrar("initdb.log", `${init.stdout}\n${init.stderr}`);
  if (init.status !== 0) falhar(`initdb falhou (${init.status})`);
  exigirCaminhoReal(DIR, true);
  fs.appendFileSync(path.join(DIR, "postgresql.conf"),
    `\n# cluster sintético kidmais 061/062\nlisten_addresses = '${HOST}'\nport = ${PORTA}\ncluster_name = '${PAPEL}'\nlc_messages = 'C'\n`);
  const log = path.join(RELATORIOS, "server.log");
  fs.mkdirSync(RELATORIOS, { recursive: true });
  // stdio ignorado: no Windows o postgres herdaria os pipes e o spawnSync nunca terminaria (o log vai para -l).
  const inicio = executarBinario("pg_ctl.exe", ["-D", DIR, "-l", log, "-o", `-p ${PORTA}`, "-w", "-t", "120", "start"], { stdio: "ignore" });
  registrar("pg_ctl-start.log", `status ${inicio.status}`);
  if (inicio.status !== 0) falhar(`pg_ctl start falhou (${inicio.status}); veja ${log}`);
  try {
    const id = await provarIdentidade();
    console.log(`cluster pronto e provado: ${JSON.stringify(id)}`);
    registrar("identidade-preparar.json", id);
  } catch (erro) {
    pararEsteCluster();
    throw erro;
  }
}

async function executar() {
  exigirAutorizacao();
  exigirCaminhoReal(DIR, true);
  if (!fs.existsSync(path.join(DIR, "postmaster.pid"))) falhar("o cluster deste diretório não está em execução");
  const id = await provarIdentidade();
  registrar("identidade-executar.json", id);
  const env = ambienteLimpo({
    KIDMAIS_POSTGRES_DESCARTAVEL: "kidmais_pacotes_v1_descartavel",
    KIDMAIS_DESCARTAVEL_PORTA: String(PORTA),
    KIDMAIS_DESCARTAVEL_AUTORIZACAO: `${HOST}:${PORTA}/kidmais_pacotes_v1_descartavel`,
  });
  const saida = path.join(RELATORIOS, `${new Date().toISOString().replace(/[:.]/g, "-")}-check-v1-postgres.log`);
  fs.mkdirSync(RELATORIOS, { recursive: true });
  const arquivo = fs.createWriteStream(saida);
  const filho = spawn(process.execPath, ["scripts/regressao-v1-postgres.cjs"], { cwd: raiz, env, windowsHide: true });
  for (const fluxo of [filho.stdout, filho.stderr]) fluxo.on("data", (parte) => { process.stdout.write(parte); arquivo.write(parte); });
  const codigo = await new Promise((resolve) => filho.on("close", resolve));
  arquivo.end();
  console.log(`\nrelatório: ${saida} (saída ${codigo})`);
  process.exitCode = codigo ?? 1;
}

async function encerrar() {
  exigirAutorizacao();
  exigirCaminhoReal(DIR, true);
  if (fs.existsSync(path.join(DIR, "postmaster.pid"))) {
    await provarIdentidade();
    const r = pararEsteCluster();
    registrar("pg_ctl-stop.log", `${r.stdout}\n${r.stderr}`);
    if (r.status !== 0) falhar(`pg_ctl stop falhou (${r.status})`);
  }
  const status = executarBinario("pg_ctl.exe", ["-D", DIR, "status"]);
  if (status.status !== 3) falhar(`o cluster não confirmou parada (pg_ctl status ${status.status})`);
  if (await alguemEscuta()) falhar(`ainda há servidor na porta ${PORTA}`);
  const evidencia = { parado: true, pgCtlStatus: status.status, saida: status.stdout.trim(), postmasterPid: fs.existsSync(path.join(DIR, "postmaster.pid")) };
  console.log(`encerrado: ${JSON.stringify(evidencia)}`);
  registrar("encerramento.json", evidencia);
}

function semRedirecionamentoDentro(dir) {
  for (const nome of fs.readdirSync(dir)) {
    const p = path.join(dir, nome);
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) falhar(`${p} é junction/symlink; limpeza recursiva recusada`);
    if (st.isDirectory()) semRedirecionamentoDentro(p);
  }
}

async function limpar() {
  exigirAutorizacao();
  exigirCaminhoReal(DIR, true);
  const conf = fs.readFileSync(path.join(DIR, "postgresql.conf"), "utf8");
  if (!conf.includes(`cluster_name = '${PAPEL}'`) || !conf.includes(`port = ${PORTA}`)) falhar("postgresql.conf não é o do cluster sintético");
  if (!fs.existsSync(path.join(DIR, "PG_VERSION"))) falhar("o diretório não é um cluster PostgreSQL");
  if (fs.existsSync(path.join(DIR, "postmaster.pid"))) falhar("postmaster.pid presente: encerre o cluster antes");
  const status = executarBinario("pg_ctl.exe", ["-D", DIR, "status"]);
  if (status.status !== 3) falhar(`pg_ctl status ${status.status}: o cluster não está parado`);
  if (await alguemEscuta()) falhar(`há servidor na porta ${PORTA}`);
  semRedirecionamentoDentro(DIR);
  fs.rmSync(DIR, { recursive: true, force: false });
  if (fs.existsSync(DIR)) falhar("o diretório continua existindo");
  const evidencia = { removido: DIR, existeDepois: fs.existsSync(DIR), relatoriosPreservados: RELATORIOS, arquivos: fs.readdirSync(RELATORIOS) };
  console.log(`limpo: ${JSON.stringify(evidencia)}`);
  registrar("limpeza.json", evidencia);
}

/** Só prova a identidade do cluster deste diretório (somente leitura); divergência = falha. */
async function provar() {
  exigirAutorizacao();
  exigirCaminhoReal(DIR, true);
  if (!fs.existsSync(path.join(DIR, "postmaster.pid"))) falhar("o cluster deste diretório não está em execução");
  const id = await provarIdentidade();
  console.log(`identidade provada: ${JSON.stringify(id)}`);
  registrar("identidade-provar.json", id);
}

const acoes = { preparar, provar, executar, encerrar, limpar };
const acao = acoes[process.argv[2]];
if (!acao) {
  console.error("uso: node scripts/pg-descartavel-061.cjs preparar|provar|executar|encerrar|limpar");
  process.exit(2);
}
acao().catch((erro) => {
  console.error(erro instanceof Error ? erro.message : String(erro));
  process.exit(1);
});
