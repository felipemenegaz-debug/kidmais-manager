/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Receita canônica do PostgreSQL descartável das suítes `*.postgres.test.ts` (D3).
 *
 * A base NUNCA vem de um banco deixado por uma execução anterior: a receita recria, a partir do schema
 * vazio, um modelo por estado declarado, aplicando as migrations do inventário oficial
 * (scripts/production/check-migrations.mjs) em ordem, com os checks exigidos por esse mesmo inventário.
 * Antes de cada suíte, o runner restaura o banco de trabalho a partir do modelo que ela declara
 * (`CREATE DATABASE ... TEMPLATE`), então nenhuma suíte depende de outra.
 *
 * Estados:
 *   atual — 001→054 + 056 + 057: o estado corrente do produto (055a–d exigem autorização e ficam fora; as
 *           suítes da 055 instalam e removem a 055 em transação/limpeza própria).
 *   053   — 001→053: o estado imediatamente anterior à 054 (a suíte da migration 054 aplica a 054).
 *   061   — inventário inteiro até a 061 (com 055a–d, 058 e 059): etapa da integração sem a agenda por unidade.
 *   062   — inventário inteiro até a 062: etapa final (agenda por empresa e unidade).
 *   063   — inventário inteiro até a 063: painel do desenvolvedor (concessão, interessadas, convites, recuperação).
 *   075   — inventário inteiro até a 075: migrations atuais (planos 074a com as travas comerciais e renovação 075).
 *
 * Segurança (fail-closed, antes de qualquer escrita):
 *   - host 127.0.0.1, usuário kidmais_descartavel, porta autorizada pela mesma regra de
 *     lib/comercial/alvo-descartavel.ts (padrão 55498; outra porta só com a autorização literal);
 *   - o servidor precisa se identificar com cluster_name = 'kidmais_descartavel', na porta e no
 *     endereço esperados, e o cluster não pode conter o banco real `kidmais_manager`;
 *   - só os nomes de banco desta lista são criados ou removidos; DATABASE_URL e PG* nunca participam.
 *
 * Fixture da 046: a única pré-condição que as migrations não semeiam é a identidade administrativa
 * aprovada. A receita cria um usuário SINTÉTICO com o e-mail que a própria 046 declara (nunca impresso),
 * papel REPRESENTANTE_AUTORIZADO e senha_hash de bytes aleatórios no formato exigido (não autentica).
 */
const fs = require("node:fs");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const { pathToFileURL } = require("node:url");

const raiz = path.resolve(__dirname, "..");
const HOST = "127.0.0.1";
const USUARIO = "kidmais_descartavel";
const CLUSTER = "kidmais_descartavel";
// Sem porta padrão: a porta vem sempre de KIDMAIS_DESCARTAVEL_PORTA com a autorização literal (cluster autorizado: 55498).
const BANCO_REAL = "kidmais_manager";

const MODELOS = {
  atual: { banco: "kidmais_v1_modelo_atual", ate: "057", sem: ["055a", "055b", "055c", "055d"] },
  "053": { banco: "kidmais_v1_modelo_053", ate: "053", sem: [] },
  "052": { banco: "kidmais_v1_modelo_052", ate: "052", sem: [] },
  "039": { banco: "kidmais_v1_modelo_039", ate: "039", sem: [] },
  "042-sem-040": { banco: "kidmais_v1_modelo_042_sem_040", ate: "042", sem: ["040"] },
  "045-sem-040": { banco: "kidmais_v1_modelo_045_sem_040", ate: "045", sem: ["040"] },
  // Etapas da publicação da integração/agenda (061 e 062), com todo o inventário anterior: provam os módulos nativos
  // DEPOIS de cada migration (as suítes que declaram `tambem` rodam também nesses estados).
  "061": { banco: "kidmais_v1_modelo_061", ate: "061", sem: [] },
  "062": { banco: "kidmais_v1_modelo_062", ate: "062", sem: [] },
  // Painel do desenvolvedor (063): inventário inteiro até a 063.
  "063": { banco: "kidmais_v1_modelo_063", ate: "063", sem: [] },
  // Migrations atuais (073–075): a cobrança roda também com a trava comercial e os gatilhos da 074a instalados.
  "075": { banco: "kidmais_v1_modelo_075", ate: "075", sem: [] },
};
/** Modelo dos roteiros de navegador: 063 (padrão) ou 075 (migrations atuais, com 067/068/074a/075). Outro valor é recusado. */
function modeloE2E(env = process.env) {
  const m = env.KIDMAIS_E2E_MODELO ?? "063";
  if (m !== "063" && m !== "075") throw new Error(`KIDMAIS_E2E_MODELO inválido: ${m}`);
  return m;
}
/** Bancos de trabalho que o runner pode restaurar. */
const TRABALHO = ["kidmais_pacotes_v1_descartavel", "kidmais_pacotes_v1_rollback"];
const GERENCIAVEIS = new Set([...TRABALHO, ...Object.values(MODELOS).map((m) => m.banco)]);

/** Mesma regra de lib/comercial/alvo-descartavel.ts (espelhada; um teste estático confere as duas). */
function portaAutorizada(env = process.env) {
  if (env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") throw new Error("suíte PostgreSQL sem opt-in explícito (KIDMAIS_POSTGRES_DESCARTAVEL): nenhuma conexão tentada.");
  const texto = env.KIDMAIS_DESCARTAVEL_PORTA;
  if (texto === undefined || texto === "") throw new Error("KIDMAIS_DESCARTAVEL_PORTA ausente: sem porta padrão");
  if (!/^[0-9]{4,5}$/.test(texto)) throw new Error("KIDMAIS_DESCARTAVEL_PORTA inválida");
  const porta = Number(texto);
  if (porta < 1024 || porta > 65535) throw new Error("KIDMAIS_DESCARTAVEL_PORTA fora do intervalo");
  const esperada = `127.0.0.1:${porta}/kidmais_pacotes_v1_descartavel`;
  if (env.KIDMAIS_DESCARTAVEL_AUTORIZACAO !== esperada) throw new Error(`porta descartável ${porta} exige KIDMAIS_DESCARTAVEL_AUTORIZACAO=${esperada}`);
  return porta;
}

function exigirGerenciavel(banco) {
  if (!GERENCIAVEIS.has(banco) || banco === BANCO_REAL) throw new Error(`banco recusado pela receita: ${banco}`);
  return banco;
}

/** Conecta e prova a identidade do servidor antes de qualquer outro SQL. */
async function conectar(porta, banco) {
  const pg = require("pg");
  const { variavelDeConexaoHerdada } = require("./regressao-v1-selecao.cjs");
  const herdadas = Object.keys(process.env).filter(variavelDeConexaoHerdada);
  if (herdadas.length) throw new Error(`receita recusada: configuração de conexão herdada (${herdadas.join(", ")})`);
  // Tudo explícito; senha nunca é carregada (trust local: pedido de senha = destino divergente).
  const client = new pg.Client({
    host: HOST, port: porta, user: USUARIO, database: banco, application_name: "kidmais-receita",
    password: () => Promise.reject(new Error("receita: o servidor pediu senha; nenhuma credencial é carregada")),
  });
  await client.connect();
  try {
    const r = await client.query(
      `SELECT current_setting('cluster_name') AS cluster, host(inet_server_addr()) AS addr, inet_server_port() AS port,
              current_user AS usuario, current_database() AS banco,
              EXISTS (SELECT 1 FROM pg_database WHERE lower(datname) = $1) AS tem_real`,
      [BANCO_REAL],
    );
    const id = r.rows[0];
    if (id.cluster !== CLUSTER || id.addr !== HOST || Number(id.port) !== porta || id.usuario !== USUARIO || id.banco !== banco || id.tem_real) {
      throw new Error("identidade do cluster descartável não confirmada; nada foi escrito");
    }
  } catch (erro) {
    await client.end();
    throw erro;
  }
  return client;
}

async function carregarInventario() {
  const inventario = await import(pathToFileURL(path.join(raiz, "scripts/production/check-migrations.mjs")).href);
  return { arquivos: [...inventario.approvedFiles], checks: inventario.requiredChecks };
}

const ler = (relativo) => fs.readFileSync(path.join(raiz, relativo), "utf8");

/** Usuário sintético da 046 (e-mail da própria migration; bytes aleatórios no formato scrypt do CHECK). */
async function fixture046(client, arquivo046) {
  const email = (ler(`database/migrations/${arquivo046}`).match(/email_alvo text := '([^']+)'/) ?? [])[1];
  if (!email) throw new Error("046: e-mail da identidade aprovada não encontrado na migration");
  const b64 = (n) => randomBytes(n).toString("base64").replace(/=+$/, "");
  const hash = `scrypt$v=1$N=131072$r=8$p=1$${b64(16)}==$${b64(64)}==`;
  await client.query(
    `INSERT INTO usuarios_administrativos (email, nome, cargo, senha_hash, papel, ativo)
     VALUES (lower(btrim($1)), 'Representante Fixture Sintética', 'Fixture de teste', $2, 'REPRESENTANTE_AUTORIZADO', true)`,
    [email, hash],
  );
}

/** Aplica uma migration com os checks do inventário: prechecks antes; o resto (backfill, postcheck) depois. */
async function aplicarMigration(client, arquivo, checks) {
  const exigidos = checks(arquivo);
  if (arquivo.split("_")[1] === "046") await fixture046(client, arquivo);
  for (const c of exigidos.filter((x) => x.includes("precheck"))) await client.query(ler(`database/checks/${c}`));
  await client.query(ler(`database/migrations/${arquivo}`));
  for (const c of exigidos.filter((x) => !x.includes("precheck"))) await client.query(ler(`database/checks/${c}`));
}

async function removerBanco(admin, banco) {
  await admin.query(`DROP DATABASE IF EXISTS ${exigirGerenciavel(banco)}`);
}

/** Recria o modelo do schema vazio: nada herdado de execução anterior. */
async function construirModelo(admin, porta, nome, log = () => {}) {
  const modelo = MODELOS[nome];
  if (!modelo) throw new Error(`estado desconhecido: ${nome}`);
  const { arquivos, checks } = await carregarInventario();
  const fim = arquivos.findIndex((a) => a.split("_")[1] === modelo.ate);
  if (fim < 0) throw new Error(`checkpoint ${modelo.ate} fora do inventário`);
  await removerBanco(admin, modelo.banco);
  await admin.query(`CREATE DATABASE ${exigirGerenciavel(modelo.banco)} TEMPLATE template0`);
  const client = await conectar(porta, modelo.banco);
  try {
    for (const arquivo of arquivos.slice(0, fim + 1).filter((a) => !modelo.sem.includes(a.split("_")[1]))) {
      await aplicarMigration(client, arquivo, checks);
      log(`  ${nome}: ${arquivo}`);
    }
  } finally {
    await client.end();
  }
}

/** Banco de trabalho novo, clonado do modelo do estado declarado. */
async function restaurar(admin, destino, nome) {
  const modelo = MODELOS[nome];
  if (!modelo || !TRABALHO.includes(destino)) throw new Error(`restauração recusada: ${destino} ← ${nome}`);
  await removerBanco(admin, destino);
  await admin.query(`CREATE DATABASE ${exigirGerenciavel(destino)} TEMPLATE ${exigirGerenciavel(modelo.banco)}`);
}

/** Conexão administrativa no banco de manutenção do MESMO cluster provado. */
async function conectarAdmin(env = process.env) {
  const porta = portaAutorizada(env);
  return { porta, admin: await conectar(porta, "postgres") };
}

async function principal() {
  const { porta, admin } = await conectarAdmin();
  try {
    for (const nome of Object.keys(MODELOS)) {
      const inicio = Date.now();
      await construirModelo(admin, porta, nome);
      console.log(`modelo ${nome} (${MODELOS[nome].banco}) construído em ${Math.round((Date.now() - inicio) / 1000)}s`);
    }
  } finally {
    await admin.end();
  }
}

if (require.main === module) {
  principal().catch((erro) => {
    console.error(erro instanceof Error ? erro.message : String(erro));
    process.exit(1);
  });
}

module.exports = { modeloE2E, MODELOS, TRABALHO, portaAutorizada, conectar, conectarAdmin, construirModelo, restaurar, removerBanco };
