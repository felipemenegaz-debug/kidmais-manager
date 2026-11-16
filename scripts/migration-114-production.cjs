/* eslint-disable @typescript-eslint/no-require-imports */
// Aplicador manual da 114 (trava da configuração nos gatilhos da 019, D-LIB-6) SOMENTE no PostgreSQL do web de PRODUÇÃO, no
// Web Shell do srv-dak77m2d0e5s73b8rkkg, DEPOIS do deploy de uma árvore que traga este aplicador, o núcleo e o SQL
// (promoção de 12/11/2026; ordem em scripts/promocao-production-ordem.cjs: depois da 109, antes da 112). Núcleo comum com
// staging (scripts/migration-114-comum.cjs, sem mudança). A 114 NÃO tem checks externos: a prova é toda do núcleo (hash do
// prosrc das funções, definição efetiva dos 6 gatilhos, preservação e prova funcional KD114 dentro da transação); este
// adaptador não acrescenta nenhum check. Alvo, identidade e disco de scripts/conexao-production.cjs, no desenho do molde de
// produção (migration-100-production.cjs); configuração do cliente como a do par de staging (connectionString).
//   node scripts/migration-114-production.cjs                                               → plano, sem conexão
//   node scripts/migration-114-production.cjs --conferir-114                                → somente leitura
//   node scripts/migration-114-production.cjs --aplicar-114-autorizado --backup "<registro>" → uma vez (marcador exclusivo)
const {criarAplicador, FLAG_CONFERIR, FLAG_APLICAR} = require('./migration-114-comum.cjs');
const prd = require('./conexao-production.cjs');

const ALVO = prd.ALVO;
const DIR = prd.pastaRegistro('agenda-114-producao');
const SQL_IDENTIDADE = prd.SQL_IDENTIDADE;
const alvo = env => prd.alvoMolde(env, 'kidmais-migration-114-production');
const identidade = id => prd.identidade(id);
const exigirDisco = (...a) => prd.exigirDisco(...a);
const ORDEM = prd.ordemProducao({id: '114', conferir: FLAG_CONFERIR, aplicar: FLAG_APLICAR,
  janela: 'a 114 recria 2 funções de gatilho e cria 1 função; escritas de festa, contrato e revisão esperam a transação (lock_timeout 5 s)'});

/** O plano do núcleo cita staging em 2 itens (levantamento de crons/worker e festa de teste): em produção valem estes. */
const PRE_REQUISITO_PRODUCAO = 'crons e worker de PRODUÇÃO: serviço, commit implantado e caminhos de escrita levantados ANTES da 114 (evidência anexa ao plano de promoção)';
const CONFERENCIA_PRODUCAO = 'conferência funcional em produção só com autorização própria (empresa de teste de produção); logs do web e do worker sem KD114';
const trocar = (itens, de, para) => itens.map(x => (de.test(x) ? para : x));
function ajustarPlano(p) {
  return {...p, preRequisitos: trocar(p.preRequisitos, /^crons e worker de staging/, PRE_REQUISITO_PRODUCAO),
    ordem: trocar(p.ordem, /^conferência funcional logada: .*staging/, CONFERENCIA_PRODUCAO)};
}

const aplicador = prd.adaptar(criarAplicador({nome: 'production', ALVO, DIR, SQL_IDENTIDADE, alvo, identidade, exigirDisco: () => exigirDisco()}),
  {ordem: ORDEM, ajustarPlano});
if (require.main === module) aplicador.cli();
module.exports = {ALVO, DIR, SQL_IDENTIDADE, ORDEM, PRE_REQUISITO_PRODUCAO, CONFERENCIA_PRODUCAO, alvo, identidade, exigirDisco, ...aplicador};
