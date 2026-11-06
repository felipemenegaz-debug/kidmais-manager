/**
 * Plano "liberar agenda com mais de um salão" (rev. 6, P2-3 item 4): exceções explícitas da guarda estática. Cada uma
 * nomeia a função onde o SQL nasce (arquivo + função) e o motivo; o relatório da guarda inventaria todos os pontos de
 * chamada que chegam a ela (`excecoesAplicadas[].chamadores`). Uma exceção sem uso reprova (lista sempre exata).
 *
 * Medição da fase 0 (01/11/2026): 6 origens em lib/ e app/ (por função) e 58 arquivos de scripts/ (por arquivo, abaixo).
 */
const EXCECOES = [
  {
    arquivo: "lib/comercial/pacotes-admin.ts", funcao: "excluirPacoteArquivadoAdmin",
    motivo: "SELECT count(*) FROM <tabela> WHERE <coluna> = $1: tabela e coluna vêm do catálogo de FKs (pg_constraint) " +
      "que referenciam o pacote, passadas por identificadorSql. Só leitura.",
  },
  {
    arquivo: "lib/exportacao/pacote.ts", funcao: "lerDados",
    motivo: "Exportação verificável: DECLARE CURSOR/SELECT/FETCH com tabelas da lista ENTIDADES e colunas lidas do " +
      "information_schema, numa transação REPEATABLE READ READ ONLY aberta por quem chama. Só leitura.",
  },
  {
    arquivo: "lib/assinatura/recuperacao-fotografia.ts", funcao: "fotografar",
    motivo: "SELECT to_jsonb(t) FROM public.<tabela> WHERE <filtro>: tabela e filtro só da lista fechada TABELAS/FILTROS " +
      "do próprio módulo (fotografia da recuperação B-14). Só leitura.",
  },
  {
    arquivo: "lib/assinatura/recuperacao-fotografia.ts", funcao: "regravarDoInstante",
    motivo: "UPDATE empresa_assinaturas SET <coluna> = $2: a coluna só passa se estiver na lista fechada REGRAVAVEIS " +
      "(conferida antes, senão erro); chamada pela interface deps.regravar da recuperação B-14 (por isso sem chamador direto).",
  },
  {
    arquivo: "lib/fechamentos/harness-054.ts", funcao: "vinculosDaEmpresa054",
    motivo: "SELECT count(*) FROM <esquema>.<tabela> WHERE <coluna> = $1: identificadores do catálogo de FKs para " +
      "empresas (SQL_FKS_EMPRESA), passados por identificador(). Só leitura.",
  },
  {
    arquivo: "lib/festas/service.ts", funcao: "salvarFilho",
    motivo: "INSERT/UPDATE em festa_tarefas, festa_pendencias ou festa_solicitacoes (literais nos ramos de comandarFesta); " +
      "as colunas são as chaves do objeto montado nos mesmos ramos (com spreads condicionais, por isso não resolvidas). " +
      "Nenhuma dessas tabelas tem salao_id.",
  },
];

/**
 * Exceções por arquivo em scripts/ (decisão de Felipe em 01/11/2026, "Exceção por arquivo"): `funcao: "*"` cobre toda
 * origem não resolvida do arquivo; vale só em scripts/ e nunca em lib/ ou app/. Os chamadores continuam inventariados.
 */
const MOTIVO_APLICADOR =
  "Aplicador, ensaio ou verificação de migration fora do runtime da aplicação: o SQL é o texto de database/*.sql lido " +
  "com readFileSync (ou trechos dele) e consultas montadas com identificadores do catálogo (pg_*/information_schema). " +
  "O conteúdo dos .sql é coberto pela verificação de arquivos .sql desta guarda; quando roda na regressão PG, a guarda " +
  "dinâmica (KD901) vale para qualquer escrita de salão.";
const MOTIVO_DIAGNOSTICO =
  "Integração, diagnóstico ou conferência local fora do runtime da aplicação, sem arquivo .sql: SQL montado com " +
  "identificadores do catálogo (pg_*/information_schema) ou listas internas do próprio script. Quando roda na regressão " +
  "PG, a guarda dinâmica (KD901) vale para qualquer escrita de salão.";
const APLICADORES = [
  "assinatura-schema-completo.cjs", "capturar-retratos-renovacao.mjs", "concorrencia-vagas-isolado.cjs",
  "ensaio-lancamento-local.cjs", "ensaio-migracoes-producao-20261019.cjs", "ensaio-reparo-bloqueios-producao-20261020.cjs",
  "festa-016-prepare-environments.cjs", "festa-016-preservacao.cjs", "festa-016-verify-environments.cjs",
  "migration-013.apply.cjs", "migration-014.apply.cjs", "migration-014.validation.cjs", "migration-015.integration.cjs",
  "migration-016.integration.cjs", "migration-078-staging.cjs", "migration-079-production.cjs", "migration-079-staging.cjs",
  "migration-083-staging.cjs", "migration-084-production.cjs",
  // Merge com staging 5f38b31a (03/11/2026): aplicadores 087 (cobrança) e 112 (cliente PJ), mesma forma dos demais
  // (os wrappers -staging/-production só herdavam a origem do -comum; sem exceção própria, lista exata).
  "migration-087-comum.cjs", "migration-112-comum.cjs", "migration-084-staging.cjs", "migration-085-086-staging.cjs",
  "migration-088-comum.cjs", "migration-089-comum.cjs", "migration-090-comum.cjs", "migration-091-comum.cjs",
  "migration-092-094-comum.cjs", "migration-095-comum.cjs", "migration-096-comum.cjs", "migration-097-comum.cjs",
  "migration-098-comum.cjs", "migration-099-comum.cjs", "migration-099-staging.cjs", "migration-100-comum.cjs",
  "migration-102-103-comum.cjs", "migration-104-106-comum.cjs", "migration-105-comum.cjs",
  "migration-105-production-nucleo.cjs", "migration-107-108-comum.cjs", "migration-108-evidencias.cjs",
  "migration-109-comum.cjs", "migrations-076-077-staging.cjs", "migrations-lancamento-production.cjs",
  "migrations-producao-20261019.cjs", "modelos-oficiais.integridade.cjs", "navegador-local-seed.cjs",
  "reparo-bloqueios-producao-20261020.cjs", "testar-reenvio-postgres.mjs", "verificacao-acabamento.cjs",
  "verificacao-final-013.cjs",
  // Merge com staging a7951a2e (04/11/2026): aplicador 116 (franquias por plano), mesma forma do 112 (o wrapper -staging
  // só herda a origem do -comum; sem exceção própria).
  "migration-116-comum.cjs",
  // Merge com staging 40e50fd7 (05/11/2026): aplicador 117 (atendimento multiempresa, #334), mesma forma do 116; as
  // origens do wrapper -staging nascem no -comum (sem exceção própria).
  "migration-117-comum.cjs",
  // Aplicador da 114 (trava da configuração), mesma forma do 117: as origens do wrapper -staging nascem no -comum.
  "migration-114-comum.cjs",
];
const DIAGNOSTICOS = [
  "catalogo-021.integration.cjs", "conferencia-b5-producao.cjs", "contrato-revisao-inicial.integration.mjs",
  "festa-016-ambiente.integration.cjs", "festa-016.integration.cjs", "festa-019.integration.mjs",
  "fixture-atualizacao-staging.cjs", "regressao-v1-postgres-receita.cjs", "regressao-v1-staging.cjs",
];
for (const nome of APLICADORES) EXCECOES.push({ arquivo: `scripts/${nome}`, funcao: "*", grupo: "aplicador", motivo: MOTIVO_APLICADOR });
for (const nome of DIAGNOSTICOS) EXCECOES.push({ arquivo: `scripts/${nome}`, funcao: "*", grupo: "diagnostico", motivo: MOTIVO_DIAGNOSTICO });

module.exports = { EXCECOES };
