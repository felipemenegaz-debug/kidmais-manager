/* eslint-disable @typescript-eslint/no-require-imports */
// Aplicador manual da 116 (franquias de IA por plano, F1) SOMENTE no PostgreSQL do web de PRODUÇÃO, no Web Shell do
// srv-dak77m2d0e5s73b8rkkg, DEPOIS do deploy de uma árvore que traga este aplicador, o núcleo e os 3 SQL (promoção de
// 12/11/2026; ordem em scripts/promocao-production-ordem.cjs: depois da 112, antes da 117). Núcleo comum com staging
// (scripts/migration-116-comum.cjs, sem mudança). Alvo, identidade e disco de scripts/conexao-production.cjs, no desenho do
// molde de produção (migration-100-production.cjs), com a rigidez do par de staging: variáveis PG* herdadas recusadas,
// `?`/`#` recusados, credencial sem caractere de controle e configuração explícita sem connectionString.
//   node scripts/migration-116-production.cjs                                               → plano, sem conexão
//   node scripts/migration-116-production.cjs --conferir-116                                → somente leitura
//   node scripts/migration-116-production.cjs --aplicar-116-autorizado --backup "<registro>" → uma vez (marcador exclusivo)
const {criarAplicador, FLAG_CONFERIR, FLAG_APLICAR} = require('./migration-116-comum.cjs');
const prd = require('./conexao-production.cjs');

const ALVO = prd.ALVO;
const DIR = prd.pastaRegistro('creditos-franquias-116-producao');
const SQL_IDENTIDADE = prd.SQL_IDENTIDADE;
const PG_HERDADAS_RECUSADAS = prd.PG_HERDADAS_RECUSADAS;
const alvo = env => prd.alvoRigido(env, 'kidmais-migration-116-production');
const identidade = id => prd.identidade(id);
const exigirDisco = (...a) => prd.exigirDisco(...a);
const ORDEM = prd.ordemProducao({id: '116', conferir: FLAG_CONFERIR, aplicar: FLAG_APLICAR,
  janela: 'fora do minuto do cron de reconciliação; escritas em notificações, lotes, carteiras e contratações esperam a transação (lock_timeout 5 s); CREDITOS_FRANQUIA_PLANO_ATIVO continua desligada'});

const aplicador = prd.adaptar(criarAplicador({nome: 'production', ALVO, DIR, SQL_IDENTIDADE, alvo, identidade, exigirDisco: () => exigirDisco()}), {ordem: ORDEM});
if (require.main === module) aplicador.cli();
module.exports = {ALVO, DIR, PG_HERDADAS_RECUSADAS, SQL_IDENTIDADE, ORDEM, alvo, identidade, exigirDisco, ...aplicador};
