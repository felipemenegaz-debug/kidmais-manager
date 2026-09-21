/* eslint-disable @typescript-eslint/no-require-imports */
const fs=require('fs'),path=require('path');
function assertAutomated(){
 const url=new URL(process.env.DATABASE_URL||'postgresql://invalid/invalid'),name=url.pathname.slice(1);
 if(process.env.KIDMAIS_REGRESSAO_STAGING==='SIM'){
  const stagingUrl=process.env.KIDMAIS_STAGING_DATABASE_URL?.trim(),stagingName=process.env.KIDMAIS_STAGING_DATABASE_NAME?.trim(),stagingHost=process.env.KIDMAIS_STAGING_DATABASE_HOST?.trim().toLowerCase();
  const sslmode=url.searchParams.get('sslmode')?.toLowerCase();
  if(!stagingUrl||!stagingName||!stagingHost||process.env.DATABASE_URL!==stagingUrl||name!==stagingName||!/^kidmais_staging(?:_[a-z0-9]+)*$/.test(name)||url.hostname.toLowerCase()!==stagingHost||['localhost','127.0.0.1','::1'].includes(url.hostname.toLowerCase())||!['require','verify-ca','verify-full'].includes(sslmode))throw Error('Teste recusado: configuração de staging inválida.');
  return;
 }
 if(process.env.KIDMAIS_REGRESSAO_HOMOLOGACAO==='SIM'&&name==='kidmais_v1_homologacao')return;
 const registry=JSON.parse(fs.readFileSync(path.join(__dirname,'../.local-festa/environments.json'),'utf8'));
 if(name===registry.manual||!registry.automated.includes(name))throw Error('Teste recusado: use somente o clone automatizado cadastrado. O clone manual está protegido.');
}
module.exports={assertAutomated};
