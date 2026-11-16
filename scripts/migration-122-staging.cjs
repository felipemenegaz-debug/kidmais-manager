/* eslint-disable @typescript-eslint/no-require-imports */
const anterior=require('./migration-118-staging.cjs');
const {criarAplicador}=require('./migration-122-comum.cjs');
const amb={...anterior,nome:'staging',DIR:'/opt/render/project/src/data/oportunidades-122-staging'};
const aplicador=criarAplicador(amb);
if(require.main===module)aplicador.cli();
module.exports={...amb,...aplicador};
