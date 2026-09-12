/* eslint-disable @typescript-eslint/no-require-imports */
const fs=require('fs'),path=require('path');
function assertAutomated(){
 const url=new URL(process.env.DATABASE_URL||'postgresql://invalid/invalid'),name=url.pathname.slice(1);
 if(process.env.KIDMAIS_REGRESSAO_HOMOLOGACAO==='SIM'&&name==='kidmais_v1_homologacao')return;
 const registry=JSON.parse(fs.readFileSync(path.join(__dirname,'../.local-festa/environments.json'),'utf8'));
 if(name===registry.manual||!registry.automated.includes(name))throw Error('Teste recusado: use somente o clone automatizado cadastrado. O clone manual está protegido.');
}
module.exports={assertAutomated};
