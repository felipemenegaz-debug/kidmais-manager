/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const test = require("node:test");

const {
  assertHomologacaoAmbiente,
  criarAmbienteFilho,
  criarComando,
  OTP_PEPPER_HOMOLOGACAO,
  selecionarSuites,
  todasAsSuites,
} = require("./regressao-v1-clone.cjs");

const URL_HOMOLOGACAO =
  "postgresql://usuario:senha@127.0.0.1:5432/kidmais_v1_homologacao";

function comAmbiente(valores, executar) {
  const chaves = [
    "KIDMAIS_REGRESSAO_HOMOLOGACAO",
    "KIDMAIS_HOMOLOGACAO_DATABASE_URL",
  ];
  const anterior = Object.fromEntries(
    chaves.map((chave) => [chave, process.env[chave]]),
  );

  try {
    for (const chave of chaves) {
      const valor = valores[chave];
      if (valor === undefined) delete process.env[chave];
      else process.env[chave] = valor;
    }
    executar();
  } finally {
    for (const chave of chaves) {
      const valor = anterior[chave];
      if (valor === undefined) delete process.env[chave];
      else process.env[chave] = valor;
    }
  }
}

test("sem argumentos seleciona todas as suítes na ordem definida", () => {
  assert.deepEqual(selecionarSuites([]), todasAsSuites);
});

test("argumento explícito seleciona somente identidade-repository", () => {
  assert.deepEqual(selecionarSuites(["identidade-repository"]), [
    "identidade-repository",
  ]);
});

test("suíte inexistente é recusada", () => {
  assert.throws(
    () => selecionarSuites(["suite-inexistente"]),
    /Suite não autorizada nesta regressão: suite-inexistente/,
  );
});

test("jornada completa usa a suíte existente de condição de pagamento", () => {
  assert.deepEqual(
    criarComando("jornada-fechamento-contrato-otp-pagamento"),
    {
      args: ["./scripts/condicao-pagamento.integration.cjs"],
      arquivo: "./scripts/condicao-pagamento.integration.cjs",
    },
  );
});

test("vigência e remarcação usam a suíte Festa 016 existente", () => {
  assert.deepEqual(criarComando("festa-vigencia-remarcacao"), {
    args: ["./scripts/festa-016-vigencia.cjs"],
    arquivo: "./scripts/festa-016-vigencia.cjs",
  });
});

test("homologação injeta pepper sintético somente no processo-filho", () => {
  const ambientePai = {
    KIDMAIS_REGRESSAO_HOMOLOGACAO: "SIM",
    IDENTIDADE_OTP_PEPPER: "valor-do-ambiente-pai-nao-deve-ser-usado",
  };
  const ambienteFilho = criarAmbienteFilho(URL_HOMOLOGACAO, ambientePai);

  assert.equal(
    ambienteFilho.IDENTIDADE_OTP_PEPPER,
    OTP_PEPPER_HOMOLOGACAO,
  );
  assert.notEqual(
    ambienteFilho.IDENTIDADE_OTP_PEPPER,
    ambientePai.IDENTIDADE_OTP_PEPPER,
  );
  assert.equal(ambientePai.DATABASE_URL, undefined);
});

test("pepper real do ambiente pai não é necessário em homologação", () => {
  const ambienteFilho = criarAmbienteFilho(URL_HOMOLOGACAO, {
    KIDMAIS_REGRESSAO_HOMOLOGACAO: "SIM",
  });

  assert.equal(
    ambienteFilho.IDENTIDADE_OTP_PEPPER,
    "kidmais-homologacao-v1-otp-pepper-nao-producao",
  );
});

test("homologação habilita Festa somente no ambiente-filho", () => {
  const ambientePai = {
    KIDMAIS_REGRESSAO_HOMOLOGACAO: "SIM",
  };
  const ambienteFilho = criarAmbienteFilho(URL_HOMOLOGACAO, ambientePai);

  assert.equal(ambientePai.FESTA_ENABLED, undefined);
  assert.equal(ambienteFilho.FESTA_ENABLED, "true");
});

test("fora da homologação não existe fallback para pepper sintético", () => {
  assert.throws(
    () => criarAmbienteFilho(URL_HOMOLOGACAO, {}),
    /só pode ser injetado na regressão de homologação/,
  );
});

test("fora da homologação não existe habilitação automática de Festa", () => {
  assert.throws(
    () => criarAmbienteFilho(URL_HOMOLOGACAO, { FESTA_ENABLED: "false" }),
    /só pode ser injetado na regressão de homologação/,
  );
});

test("guardas aceitam somente opt-in e clone local exato", () => {
  comAmbiente(
    {
      KIDMAIS_REGRESSAO_HOMOLOGACAO: "SIM",
      KIDMAIS_HOMOLOGACAO_DATABASE_URL: URL_HOMOLOGACAO,
    },
    () => assert.equal(assertHomologacaoAmbiente(), URL_HOMOLOGACAO),
  );

  comAmbiente(
    {
      KIDMAIS_REGRESSAO_HOMOLOGACAO: undefined,
      KIDMAIS_HOMOLOGACAO_DATABASE_URL: URL_HOMOLOGACAO,
    },
    () => assert.throws(assertHomologacaoAmbiente, /exige KIDMAIS_REGRESSAO/),
  );

  comAmbiente(
    {
      KIDMAIS_REGRESSAO_HOMOLOGACAO: "SIM",
      KIDMAIS_HOMOLOGACAO_DATABASE_URL: undefined,
    },
    () => assert.throws(assertHomologacaoAmbiente, /URL ausente/),
  );

  comAmbiente(
    {
      KIDMAIS_REGRESSAO_HOMOLOGACAO: "SIM",
      KIDMAIS_HOMOLOGACAO_DATABASE_URL:
        "postgresql://usuario:senha@db.example.invalid:5432/kidmais_v1_homologacao",
    },
    () => assert.throws(assertHomologacaoAmbiente, /somente loopback/),
  );

  comAmbiente(
    {
      KIDMAIS_REGRESSAO_HOMOLOGACAO: "SIM",
      KIDMAIS_HOMOLOGACAO_DATABASE_URL:
        "postgresql://usuario:senha@127.0.0.1:5432/kidmais_manager",
    },
    () => assert.throws(assertHomologacaoAmbiente, /kidmais_manager/),
  );
});
