/* eslint-disable @typescript-eslint/no-require-imports */
// Aplicador manual da 117 (atendimento WhatsApp multiempresa, E-ME1/E-ME2) SOMENTE no PostgreSQL do web de PRODUÇÃO, no Web
// Shell do srv-dak77m2d0e5s73b8rkkg, DEPOIS do deploy de uma árvore que traga este aplicador, o núcleo e os 3 SQL (promoção
// de 12/11/2026; ordem em scripts/promocao-production-ordem.cjs: depois da 116, antes da 118). Núcleo comum com staging
// (scripts/migration-117-comum.cjs, sem mudança). O NÚCLEO recusa aplicar com WHATSAPP_ATENDIMENTO_MULTIEMPRESA ligada ou
// inválida no env do processo (o Web Shell herda o env do web), ANTES de criar o marcador; este adaptador não mexe nisso e o
// teste de produção prova a recusa. Alvo, identidade e disco de scripts/conexao-production.cjs, no desenho do molde de
// produção (migration-100-production.cjs), com a rigidez do par de staging: variáveis PG* herdadas recusadas, `?`/`#`
// recusados, credencial sem caractere de controle e configuração explícita sem connectionString.
//   node scripts/migration-117-production.cjs                                               → plano, sem conexão
//   node scripts/migration-117-production.cjs --conferir-117                                → somente leitura
//   node scripts/migration-117-production.cjs --aplicar-117-autorizado --backup "<registro>" → uma vez (marcador exclusivo)
const {criarAplicador, FLAG_CONFERIR, FLAG_APLICAR} = require('./migration-117-comum.cjs');
const prd = require('./conexao-production.cjs');

const ALVO = prd.ALVO;
const DIR = prd.pastaRegistro('whatsapp-multiempresa-117-producao');
const SQL_IDENTIDADE = prd.SQL_IDENTIDADE;
const PG_HERDADAS_RECUSADAS = prd.PG_HERDADAS_RECUSADAS;
const alvo = env => prd.alvoRigido(env, 'kidmais-migration-117-production');
const identidade = id => prd.identidade(id);
const exigirDisco = (...a) => prd.exigirDisco(...a);
const ORDEM = prd.ordemProducao({id: '117', conferir: FLAG_CONFERIR, aplicar: FLAG_APLICAR,
  janela: 'WHATSAPP_ATENDIMENTO_MULTIEMPRESA DESLIGADA no web (ligada ou inválida = o aplicador recusa antes do marcador); escritas em whatsapp_atendimento_mensagens e em empresas esperam a transação (lock_timeout 5 s)'});

const aplicador = prd.adaptar(criarAplicador({nome: 'production', ALVO, DIR, SQL_IDENTIDADE, alvo, identidade, exigirDisco: () => exigirDisco()}), {ordem: ORDEM});
if (require.main === module) aplicador.cli();
module.exports = {ALVO, DIR, PG_HERDADAS_RECUSADAS, SQL_IDENTIDADE, ORDEM, alvo, identidade, exigirDisco, ...aplicador};
