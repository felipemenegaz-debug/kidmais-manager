/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");
const {
  BANCO,
  OPT_IN,
  arquivosDoCheckEstatico,
  exigirListaPostgres,
  exigirOptInDescartavel,
  listarTestesEstaticos,
  listarTestesPostgres,
} = require("./regressao-v1-selecao.cjs");

const raiz = path.resolve(__dirname, "..");

const TITULOS = [
  "escopo comercial declarado no postgres descartável",
  "remediação de pacotes no postgres descartável",
  "atribuição controlada da Kidmais no postgres descartável",
  "catálogo HG-8 no postgres descartável",
  "ciclo da empresa no postgres descartável",
  "estrutura de tenant da 043 no postgres descartável",
  "ciclo da membership no postgres descartável",
  "provisionamento sintético no postgres descartável",
  "prova de tenant no postgres descartável",
];

test("o check estático não seleciona o postgres descartável", () => {
  const estaticos = listarTestesEstaticos(raiz);
  const postgres = listarTestesPostgres(raiz);
  const plano = arquivosDoCheckEstatico(raiz);
  const fonte = fs.readFileSync(path.join(raiz, "scripts", "regressao-v1-estatica.cjs"), "utf8");
  const pacote = JSON.parse(fs.readFileSync(path.join(raiz, "package.json"), "utf8"));

  assert.equal(pacote.scripts["check:v1:static"], "node scripts/regressao-v1-estatica.cjs");
  assert.match(fonte, /arquivosDoCheckEstatico\(raiz\)/);
  assert.equal(fonte.includes('.endsWith(".test.ts")'), false);
  assert.ok(postgres.length >= TITULOS.length);
  assert.equal(estaticos.some((arquivo) => arquivo.endsWith(".postgres.test.ts")), false);
  assert.equal(plano.some((arquivo) => arquivo.endsWith(".postgres.test.ts")), false);
  assert.equal(plano.includes(path.join(raiz, "scripts", "regressao-v1-estatica.test.cjs")), true);

  for (const arquivo of postgres) {
    assert.equal(estaticos.includes(arquivo), false, arquivo);
    assert.equal(plano.includes(arquivo), false, arquivo);
    const texto = fs.readFileSync(arquivo, "utf8");
    assert.match(texto, /postgres-descartavel/);
  }

  for (const arquivo of estaticos) {
    const texto = fs.readFileSync(arquivo, "utf8");
    assert.equal(texto.includes("postgres-descartavel"), false, arquivo);
    assert.equal(texto.includes("55498"), false, arquivo);
  }
});

test("a suíte dedicada reúne os testes do postgres descartável", () => {
  const postgres = listarTestesPostgres(raiz);
  const fonteRunner = fs.readFileSync(path.join(raiz, "scripts", "regressao-v1-postgres.cjs"), "utf8");
  const pacote = JSON.parse(fs.readFileSync(path.join(raiz, "package.json"), "utf8"));
  const corpus = postgres.map((arquivo) => fs.readFileSync(arquivo, "utf8")).join("\n");

  assert.equal(pacote.scripts["check:v1:postgres"], "node scripts/regressao-v1-postgres.cjs");
  assert.ok(fonteRunner.indexOf("exigirOptInDescartavel(process.env)") >= 0);
  assert.ok(
    fonteRunner.indexOf("exigirOptInDescartavel(process.env)")
      < fonteRunner.indexOf("spawnSync("),
  );
  exigirListaPostgres(postgres);
  for (const titulo of TITULOS) {
    assert.equal(corpus.includes(`test("${titulo}"`), true, titulo);
  }
});

test("sem opt-in a suíte dedicada falha fechada e não conecta", () => {
  assert.throws(() => exigirOptInDescartavel({}));
  assert.throws(() => exigirOptInDescartavel({ DATABASE_URL: `postgresql://nao-usar@127.0.0.1:55498/${BANCO}` }));
  assert.throws(() => exigirOptInDescartavel({ [OPT_IN]: "kidmais_pacotes_v1_rollback" }));
  assert.throws(() => exigirOptInDescartavel({
    [OPT_IN]: `postgresql://kidmais_descartavel@127.0.0.1:55498/${BANCO}`,
  }));
  assert.equal(
    exigirOptInDescartavel({
      [OPT_IN]: BANCO,
      DATABASE_URL: "postgresql://nao-usar@db.example/kidmais_manager",
    }),
    BANCO,
  );
  assert.throws(() => exigirListaPostgres([]));

  const env = { ...process.env, DATABASE_URL: `postgresql://nao-usar@127.0.0.1:55498/${BANCO}` };
  delete env[OPT_IN];
  const resultado = spawnSync(process.execPath, ["scripts/regressao-v1-postgres.cjs"], {
    cwd: raiz,
    env,
    encoding: "utf8",
  });
  const saida = `${resultado.stdout ?? ""}\n${resultado.stderr ?? ""}`;
  assert.notEqual(resultado.status, 0);
  assert.match(saida, /DATABASE_URL não autoriza/);
  assert.equal(saida.includes("# tests"), false);
  assert.equal(saida.includes("# pass"), false);
  assert.equal(saida.includes("escopo comercial declarado"), false);
  assert.equal(saida.includes("ECONNREFUSED"), false);
});

test("D3: toda suíte PostgreSQL declara um estado da receita; o runner restaura por suíte e não herda banco", () => {
  const { ESTADO_POSTGRES, estadoDaSuite } = require("./regressao-v1-selecao.cjs");
  const receita = require("./regressao-v1-postgres-receita.cjs");
  const relativas = listarTestesPostgres(raiz).map((arquivo) => path.relative(raiz, arquivo).split(path.sep).join("/")).sort();
  assert.deepEqual(relativas, Object.keys(ESTADO_POSTGRES).sort(), "declaração exata: nenhuma suíte sem estado, nenhum estado órfão");
  for (const [suite, estado] of Object.entries(ESTADO_POSTGRES)) {
    assert.ok(receita.MODELOS[estado.descartavel], `${suite}: estado ${estado.descartavel}`);
    if (estado.rollback) assert.ok(receita.MODELOS[estado.rollback], `${suite}: estado ${estado.rollback}`);
  }
  assert.throws(() => estadoDaSuite(raiz, path.join(raiz, "lib", "nova", "nova.postgres.test.ts")), /sem estado declarado/);
  assert.deepEqual({ ate: receita.MODELOS.atual.ate, sem: receita.MODELOS.atual.sem }, { ate: "057", sem: ["055a", "055b", "055c", "055d"] }, "estado atual = inventário até a 057 sem a 055a–d (autorização própria)");
  const runner = fs.readFileSync(path.join(raiz, "scripts", "regressao-v1-postgres.cjs"), "utf8");
  assert.match(runner, /receita\.construirModelo\(admin, porta, modelo\)/, "modelos recriados do schema vazio a cada execução");
  assert.match(runner, /for \(const banco of receita\.TRABALHO\) await receita\.removerBanco\(admin, banco\);/, "bancos de trabalho removidos antes de cada suíte");
  assert.match(runner, /receita\.restaurar\(admin, trabalho, estado\.descartavel\)/);
  assert.match(runner, /\["--experimental-strip-types", "--test", arquivo\]/, "uma suíte por processo");
  assert.match(runner, /timeout: LIMITE_POR_SUITE_MS/, "suíte que não termina falha, não trava o gate");
  assert.match(runner, /conexoesDeTrabalho\(admin, receita\.TRABALHO\)/, "suíte que deixa conexão aberta falha");
  assert.equal(runner.includes("--test-force-exit"), false, "sem encerramento forçado");
});

test("D3: a receita usa a mesma autorização de porta das suítes e recusa banco fora da lista", async () => {
  const receita = require("./regressao-v1-postgres-receita.cjs");
  const { portaDescartavel } = require("../lib/comercial/alvo-descartavel.ts");
  const resultado = (fn, env) => { try { return fn(env); } catch { return "RECUSA"; } };
  for (const env of [
    {},
    { KIDMAIS_DESCARTAVEL_PORTA: "55521", KIDMAIS_DESCARTAVEL_AUTORIZACAO: "127.0.0.1:55521/kidmais_pacotes_v1_descartavel" },
    { KIDMAIS_DESCARTAVEL_PORTA: "55521" },
    { KIDMAIS_DESCARTAVEL_PORTA: "55521", KIDMAIS_DESCARTAVEL_AUTORIZACAO: "127.0.0.1:55521/kidmais_manager" },
    { KIDMAIS_DESCARTAVEL_PORTA: "80", KIDMAIS_DESCARTAVEL_AUTORIZACAO: "127.0.0.1:80/kidmais_pacotes_v1_descartavel" },
    { DATABASE_URL: "postgresql://x@db.example:5432/kidmais_manager", PGPORT: "5432" },
  ]) assert.equal(resultado(receita.portaAutorizada, env), resultado(portaDescartavel, env), JSON.stringify(env));
  const consultas = [];
  const falso = { query: async (sql) => { consultas.push(sql); return { rows: [] }; } };
  await assert.rejects(receita.removerBanco(falso, "kidmais_manager"), /recusado/);
  await assert.rejects(receita.restaurar(falso, "kidmais_manager", "atual"), /recusada/);
  await assert.rejects(receita.restaurar(falso, "kidmais_pacotes_v1_descartavel", "inexistente"), /recusada/);
  assert.deepEqual(consultas, [], "nenhum SQL antes da recusa");
  const fonte = fs.readFileSync(path.join(raiz, "scripts", "regressao-v1-postgres-receita.cjs"), "utf8");
  assert.match(fonte, /current_setting\('cluster_name'\)/, "identidade do cluster provada antes de escrever");
  assert.match(fonte, /EXISTS \(SELECT 1 FROM pg_database WHERE lower\(datname\) = \$1\) AS tem_real/, "cluster com o banco real é recusado");
  assert.equal(/DATABASE_URL|process\.env\.PG/.test(fonte.replace(/DATABASE_URL e PG\* nunca participam/g, "")), false, "sem destino genérico");
});
