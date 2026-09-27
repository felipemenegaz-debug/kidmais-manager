/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("node:fs");
const path = require("node:path");

const PASTAS = ["app", "components", "lib"];
const OPT_IN = "KIDMAIS_POSTGRES_DESCARTAVEL";
const BANCO = "kidmais_pacotes_v1_descartavel";

function caminhar(diretorio, aceita, encontrados) {
  if (!fs.existsSync(diretorio)) return;
  for (const item of fs.readdirSync(diretorio, { withFileTypes: true })) {
    const caminho = path.join(diretorio, item.name);
    if (item.isDirectory()) caminhar(caminho, aceita, encontrados);
    else if (aceita(item.name)) encontrados.push(caminho);
  }
}

function listar(raiz, aceita) {
  const encontrados = [];
  for (const pasta of PASTAS) caminhar(path.join(raiz, pasta), aceita, encontrados);
  return encontrados.sort();
}

function listarTestesEstaticos(raiz) {
  return listar(
    raiz,
    (nome) => nome.endsWith(".test.ts") && !nome.endsWith(".postgres.test.ts"),
  );
}

function listarTestesPostgres(raiz) {
  return listar(raiz, (nome) => nome.endsWith(".postgres.test.ts"));
}

function arquivosDoCheckEstatico(raiz) {
  return [
    ...listarTestesEstaticos(raiz),
    path.join(raiz, "scripts", "regressao-v1-estatica.test.cjs"),
  ];
}

function exigirOptInDescartavel(env) {
  const valor = env[OPT_IN];
  if (valor !== BANCO || String(valor).includes("://")) {
    throw new Error(
      `Suíte PostgreSQL descartável recusada: defina ${OPT_IN}=${BANCO}. DATABASE_URL não autoriza esta suíte e não abre conexão.`,
    );
  }
  return BANCO;
}

function exigirListaPostgres(arquivos) {
  if (!arquivos.length) {
    throw new Error(
      "Suíte PostgreSQL descartável recusada: nenhum teste descartável encontrado.",
    );
  }
  return arquivos;
}

module.exports = {
  OPT_IN,
  BANCO,
  PASTAS,
  listarTestesEstaticos,
  listarTestesPostgres,
  arquivosDoCheckEstatico,
  exigirOptInDescartavel,
  exigirListaPostgres,
};
