/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Leitura, pelo executor das suítes PG, do registro de falhas da limpeza das conexões (lib/comercial/encerramento-descartavel.ts).
 *
 * Revisão do Astra (08/11/2026, P2): o registro é auxiliar e nunca pode reprovar o executor nem interromper as suítes
 * seguintes. Toda falha de leitura ou de formato vira uma entrada de fase "registro" ou "ilegível", e nada aqui lança.
 * As mensagens são normalizadas para uma linha (sem quebras), com no máximo 200 caracteres.
 */
const fs = require("node:fs");

const umaLinha = (valor) => String(valor ?? "").replace(/[\r\n]+/g, " ").slice(0, 200);

function normalizar(entrada, linha) {
  if (!entrada || typeof entrada !== "object" || Array.isArray(entrada) || typeof entrada.fase !== "string") {
    return { fase: "ilegível", sqlstate: null, mensagem: umaLinha(linha) };
  }
  return {
    fase: umaLinha(entrada.fase),
    sqlstate: typeof entrada.sqlstate === "string" ? umaLinha(entrada.sqlstate) : null,
    mensagem: umaLinha(entrada.mensagem),
  };
}

/** Lista de falhas registradas pela suíte. Arquivo ausente: lista vazia. Nunca lança. */
function lerLimpeza(arquivo) {
  try {
    if (!fs.existsSync(arquivo)) return [];
    return fs.readFileSync(arquivo, "utf8").split(/\r?\n/).filter((linha) => linha.trim()).map((linha) => {
      try {
        return normalizar(JSON.parse(linha), linha);
      } catch {
        return { fase: "ilegível", sqlstate: null, mensagem: umaLinha(linha) };
      }
    });
  } catch (erro) {
    return [{ fase: "registro", sqlstate: null, mensagem: umaLinha(`registro de limpeza não pôde ser lido: ${erro?.message ?? erro}`) }];
  }
}

const resumoLimpeza = (falhas) => falhas.map((f) => `${f.fase} ${f.sqlstate ?? "sem SQLSTATE"}`).join(", ");

module.exports = { lerLimpeza, resumoLimpeza };
