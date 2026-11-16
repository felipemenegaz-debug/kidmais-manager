/* eslint-disable @typescript-eslint/no-require-imports */
// Aplicador manual da 112 (cliente pessoa jurídica, Entrega B) SOMENTE no PostgreSQL do web de PRODUÇÃO, no Web Shell do
// srv-dak77m2d0e5s73b8rkkg, DEPOIS do deploy de uma árvore que traga este aplicador, o núcleo e os 3 SQL (promoção de
// 12/11/2026; ordem em scripts/promocao-production-ordem.cjs: depois da 114, antes da 116). Núcleo comum com staging
// (scripts/migration-112-comum.cjs, sem mudança). Alvo, identidade (TLS e rede privada provados no servidor) e disco de
// scripts/conexao-production.cjs, no desenho do molde de produção (migration-100-production.cjs); configuração do cliente
// como a do par de staging (connectionString).
//   node scripts/migration-112-production.cjs                                               → plano, sem conexão
//   node scripts/migration-112-production.cjs --conferir-112                                → somente leitura
//   node scripts/migration-112-production.cjs --aplicar-112-autorizado --backup "<registro>" → uma vez (marcador exclusivo)
const {criarAplicador, FLAG_CONFERIR, FLAG_APLICAR} = require('./migration-112-comum.cjs');
const prd = require('./conexao-production.cjs');

const ALVO = prd.ALVO;
const DIR = prd.pastaRegistro('clientes-pj-112-producao');
const SQL_IDENTIDADE = prd.SQL_IDENTIDADE;
const alvo = env => prd.alvoMolde(env, 'kidmais-migration-112-production');
const identidade = id => prd.identidade(id);
const exigirDisco = (...a) => prd.exigirDisco(...a);
const ORDEM = prd.ordemProducao({id: '112', conferir: FLAG_CONFERIR, aplicar: FLAG_APLICAR,
  janela: 'a 112 trava clientes (ACCESS EXCLUSIVE) pelo tempo da transação; leituras e escritas de clientes esperam (lock_timeout 5 s)'});

const aplicador = prd.adaptar(criarAplicador({nome: 'production', ALVO, DIR, SQL_IDENTIDADE, alvo, identidade, exigirDisco: () => exigirDisco()}), {ordem: ORDEM});
if (require.main === module) aplicador.cli();
module.exports = {ALVO, DIR, SQL_IDENTIDADE, ORDEM, alvo, identidade, exigirDisco, ...aplicador};
