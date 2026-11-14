/* eslint-disable @typescript-eslint/no-require-imports */
const conexao=require('./conexao-production.cjs');
const {criarAplicador}=require('./migration-122-comum.cjs');
const amb={...conexao,nome:'production',DIR:conexao.pastaRegistro('oportunidades-122-producao'),alvo:env=>conexao.alvoRigido(env,'kidmais-migration-122-production')};
const aplicador=criarAplicador(amb);
if(require.main===module)aplicador.cli();
module.exports={...amb,...aplicador};
