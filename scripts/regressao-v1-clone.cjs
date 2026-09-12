/* eslint-disable @typescript-eslint/no-require-imports */
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const { URL } = require("node:url");

const TARGET_DB = "kidmais_v1_homologacao";
const OTP_PEPPER_HOMOLOGACAO =
  "kidmais-homologacao-v1-otp-pepper-nao-producao";
const todasAsSuites = [
  "identidade-repository",
  "identidade-service",
  "identidade-fechamento",
  "jornada-fechamento-contrato-otp-pagamento",
  "pagamentos-engenharia",
  "pagamentos-http",
  "festa-vigencia-remarcacao",
];

function assertHomologacaoAmbiente() {
  if (process.env.KIDMAIS_REGRESSAO_HOMOLOGACAO !== "SIM") {
    throw new Error("Regressão homologação exige KIDMAIS_REGRESSAO_HOMOLOGACAO=SIM.");
  }

  const homologacaoUrl = process.env.KIDMAIS_HOMOLOGACAO_DATABASE_URL;

  if (!homologacaoUrl) {
    throw new Error(
      "KIDMAIS_HOMOLOGACAO_DATABASE_URL ausente: variável obrigatória em homologação.",
    );
  }

  if (homologacaoUrl.includes("kidmais_manager")) {
    throw new Error(
      "KIDMAIS_HOMOLOGACAO_DATABASE_URL faz referência a kidmais_manager; isso não é permitido.",
    );
  }

  let url;

  try {
    url = new URL(homologacaoUrl);
  } catch {
    throw new Error(
      "KIDMAIS_HOMOLOGACAO_DATABASE_URL inválida: parse de URL falhou.",
    );
  }

  const host = url.hostname.toLowerCase();

  if (host !== "127.0.0.1" && host !== "localhost") {
    throw new Error(
      "KIDMAIS_HOMOLOGACAO_DATABASE_URL inválida: somente loopback (127.0.0.1/localhost) é permitido.",
    );
  }

  if (url.pathname.replace(/\/+$/, "") !== `/${TARGET_DB}`) {
    throw new Error(
      `DATABASE_URL inválida: banco deve ser ${TARGET_DB} no clone de homologação.`,
    );
  }

  if (!url.protocol || !/^postgres(ql)?:$/.test(url.protocol)) {
    throw new Error(
      "KIDMAIS_HOMOLOGACAO_DATABASE_URL inválida: protocolo PostgreSQL esperado.",
    );
  }

  return homologacaoUrl;
}

function criarComando(nome) {
  const comandos = {
    "identidade-repository": {
      args: [
        "-r",
        "./scripts/pagamentos-test-support.cjs",
        "-e",
        "require('./scripts/identidade-repository.integration.ts')",
      ],
      arquivo: "./scripts/identidade-repository.integration.ts",
    },
    "identidade-service": {
      args: [
        "-r",
        "./scripts/pagamentos-test-support.cjs",
        "-e",
        "require('./scripts/identidade-service.integration.ts')",
      ],
      arquivo: "./scripts/identidade-service.integration.ts",
    },
    "identidade-fechamento": {
      args: [
        "-r",
        "./scripts/pagamentos-test-support.cjs",
        "-e",
        "require('./scripts/identidade-fechamento.integration.ts')",
      ],
      arquivo: "./scripts/identidade-fechamento.integration.ts",
    },
    "jornada-fechamento-contrato-otp-pagamento": {
      args: ["./scripts/condicao-pagamento.integration.cjs"],
      arquivo: "./scripts/condicao-pagamento.integration.cjs",
    },
    "pagamentos-engenharia": {
      args: ["./scripts/pagamentos-engenharia.integration.cjs"],
      arquivo: "./scripts/pagamentos-engenharia.integration.cjs",
    },
    "pagamentos-http": {
      args: ["./scripts/pagamentos-http.integration.cjs"],
      arquivo: "./scripts/pagamentos-http.integration.cjs",
    },
    "festa-vigencia-remarcacao": {
      args: ["./scripts/festa-016-vigencia.cjs"],
      arquivo: "./scripts/festa-016-vigencia.cjs",
    },
  };

  const comando = comandos[nome];

  if (!comando) {
    throw new Error(`Suite desconhecida: ${nome}`);
  }

  return comando;
}

function executarSuite(nome, args, ambiente) {
  const resultado = spawnSync(process.execPath, args, {
    encoding: "utf8",
    env: ambiente,
    timeout: 240000,
    maxBuffer: 16 * 1024 * 1024,
  });

  const log = `.tmp/regressao-v1-clone.${nome}.log`;
  fs.writeFileSync(log, (resultado.stdout ?? "") + (resultado.stderr ?? ""));

  return { nome, status: resultado.status ?? 1, log };
}

function garantirArquivoExiste(arquivo, nome) {
  if (!fs.existsSync(arquivo)) {
    throw new Error(
      `Arquivo de suíte não encontrado para ${nome}: ${arquivo}. Não é seguro executar com fallback; verifique a suíte explicitamente.`,
    );
  }
}

function selecionarSuites(suitesSolicitadas) {
  const suitesAExecutar =
    suitesSolicitadas.length > 0 ? suitesSolicitadas : todasAsSuites;

  const comandoInvalido = suitesAExecutar.find(
    (nome) => !todasAsSuites.includes(nome),
  );

  if (comandoInvalido) {
    throw new Error(
      `Suite não autorizada nesta regressão: ${comandoInvalido}. Opções: ${todasAsSuites.join(", ")}.`,
    );
  }

  return suitesAExecutar;
}

function criarAmbienteFilho(databaseUrl, ambientePai = process.env) {
  if (ambientePai.KIDMAIS_REGRESSAO_HOMOLOGACAO !== "SIM") {
    throw new Error(
      "Pepper sintético só pode ser injetado na regressão de homologação.",
    );
  }

  return {
    ...ambientePai,
    DATABASE_URL: databaseUrl,
    KIDMAIS_REGRESSAO_HOMOLOGACAO: "SIM",
    IDENTIDADE_OTP_PEPPER: OTP_PEPPER_HOMOLOGACAO,
    FESTA_ENABLED: "true",
  };
}

function main() {
  const databaseUrl = assertHomologacaoAmbiente();
  fs.mkdirSync(".tmp", { recursive: true });

  const suitesSolicitadas = process.argv.slice(2);
  const suitesAExecutar = selecionarSuites(suitesSolicitadas);

  const ambiente = criarAmbienteFilho(databaseUrl);

  const resultados = [];

  for (const nome of suitesAExecutar) {
    const { args, arquivo } = criarComando(nome);
    garantirArquivoExiste(arquivo, nome);
    const resultado = executarSuite(nome, args, ambiente);
    resultados.push(resultado);
    console.log(nome, resultado.status === 0 ? "PASS" : "FALHOU");
    if (resultado.status !== 0) {
      console.log(
        "Detalhes do log:",
        fs.readFileSync(resultado.log, "utf8").slice(-1200),
      );
      break;
    }
  }

  const resultadosPath = ".tmp/regressao-v1-clone.resultados.json";
  fs.writeFileSync(resultadosPath, JSON.stringify(resultados, null, 2));

  if (resultados.some((item) => item.status !== 0)) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = {
  assertHomologacaoAmbiente,
  criarAmbienteFilho,
  criarComando,
  OTP_PEPPER_HOMOLOGACAO,
  selecionarSuites,
  todasAsSuites,
};
