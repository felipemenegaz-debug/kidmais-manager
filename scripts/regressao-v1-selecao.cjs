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

/**
 * D3 — estado de PostgreSQL declarado por suíte (receita: scripts/regressao-v1-postgres-receita.cjs).
 * Suíte de produto parte do estado canônico ATUAL; suíte de migration declara o estado histórico que testa
 * e aplica/desfaz a própria migration. Antes de CADA suíte o runner recria os bancos de trabalho a partir
 * desses modelos: nenhuma suíte depende de banco deixado por outra. Suíte sem declaração é recusada.
 *   descartavel — estado do banco kidmais_pacotes_v1_descartavel;
 *   rollback    — estado do segundo banco kidmais_pacotes_v1_rollback, quando a suíte usa dois estados;
 *   alvo054     — o banco de trabalho é também o alvo autorizado do harness da 054 (KIDMAIS_054_*).
 */
const ESTADO_POSTGRES = {
  "lib/comercial/catalogo-ux.postgres.test.ts": { descartavel: "atual" },
  "lib/comercial/hg4-escopo.postgres.test.ts": { descartavel: "atual" },
  "lib/comercial/integridade-fechamento-053.postgres.test.ts": { descartavel: "052" },
  "lib/comercial/pacotes-v1-remediacao.postgres.test.ts": { descartavel: "039", rollback: "atual" },
  "lib/comercial/round4-remediacao.postgres.test.ts": { descartavel: "atual" },
  "lib/comercial/round5-remediacao.postgres.test.ts": { descartavel: "atual" },
  "lib/comercial/supersessao-048.postgres.test.ts": { descartavel: "atual" },
  "lib/contratos/migration-057.postgres.test.ts": { descartavel: "atual" },
  "lib/fechamentos/migration-054.postgres.test.ts": { descartavel: "053", alvo054: true },
  "lib/financeiro/baixa.postgres.test.ts": { descartavel: "atual" },
  "lib/financeiro/financeiro.postgres.test.ts": { descartavel: "atual" },
  "lib/festas/tenant-festa.postgres.test.ts": { descartavel: "atual" },
  "lib/ia-persistencia/migration-055.postgres.test.ts": { descartavel: "atual" },
  "lib/ia-persistencia/uso-custos.postgres.test.ts": { descartavel: "atual" },
  "lib/ia-persistencia/migration-058.postgres.test.ts": { descartavel: "atual" },
  "lib/inteligencia/inteligencia.postgres.test.ts": { descartavel: "atual" },
  "lib/pagamentos/estorno-completo.postgres.test.ts": { descartavel: "atual" },
  "lib/pagamentos/gates-c2.postgres.test.ts": { descartavel: "atual" },
  "lib/saas/hg6-kidmais.postgres.test.ts": { descartavel: "045-sem-040" },
  "lib/saas/hg8-catalogo.postgres.test.ts": { descartavel: "atual" },
  "lib/saas/migration-056.postgres.test.ts": { descartavel: "atual" },
  "lib/saas/provar-estabelecimento.postgres.test.ts": { descartavel: "atual" },
  "lib/saas/hg8-empresa.postgres.test.ts": { descartavel: "atual" },
  "lib/saas/hg8-estrutura.postgres.test.ts": { descartavel: "042-sem-040" },
  "lib/saas/hg8-membership.postgres.test.ts": { descartavel: "atual" },
  "lib/saas/hg8-provisionar.postgres.test.ts": { descartavel: "atual" },
  "lib/saas/hg8-tenant.postgres.test.ts": { descartavel: "atual" },
};

function estadoDaSuite(raiz, arquivo) {
  const relativo = path.relative(raiz, arquivo).split(path.sep).join("/");
  const estado = ESTADO_POSTGRES[relativo];
  if (!estado) throw new Error(`Suíte PostgreSQL sem estado declarado: ${relativo}. Declare-a em ESTADO_POSTGRES.`);
  return { relativo, ...estado };
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
  ESTADO_POSTGRES,
  estadoDaSuite,
};
