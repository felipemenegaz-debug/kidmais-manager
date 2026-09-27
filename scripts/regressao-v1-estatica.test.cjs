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
