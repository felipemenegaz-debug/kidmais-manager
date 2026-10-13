/* eslint-disable @typescript-eslint/no-require-imports */
// Sequência da virada de produção (docs/RODADA_FINAL_LANCAMENTO_20261013.md): as migrations do manifesto, na ordem, uma
// por processo do aplicador revisado; para na primeira falha; depois o reparo dos cinco bloqueios. Cada etapa grava seu
// próprio marcador exclusivo (sem replay). Etapa já aplicada só roda o postcheck (somente leitura).
//   node scripts/cutover-lancamento-production.cjs --cutover-autorizado --backup <registro do backup>
const assert=require('node:assert/strict'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const {carregar}=require('./migrations-lancamento-production.cjs');

function etapas(){return [...carregar().map(e=>({tipo:'migration',id:e.id})),{tipo:'reparo',id:'bloqueios-kidmais'}];}
function comando(e,backup,dir=__dirname){
 return e.tipo==='migration'
  ?[path.join(dir,'migrations-lancamento-production.cjs'),'--aplicar-migration-autorizada',e.id,'--backup',backup]
  :[path.join(dir,'reparo-bloqueios-production.cjs'),'--aplicar-reparo-autorizado','--backup',backup];
}
/** Executa em ordem; `rodar` devolve {status, saida}. Para na primeira falha e diz onde parou. */
function sequencia(backup,rodar){
 const feitas=[];
 for(const e of etapas()){
  const r=rodar(comando(e,backup));
  if(r.status!==0)return {resultado:'PARADO',etapa:e.id,feitas,motivo:String(r.saida||'').slice(0,160)};
  feitas.push({etapa:e.id,saida:String(r.saida||'').trim().slice(0,200)});
 }
 return {resultado:'CUTOVER_BANCO_PASS',feitas};
}
function rodarNode(args){
 const p=spawnSync(process.execPath,args,{encoding:'utf8',env:process.env,timeout:180000,killSignal:'SIGTERM'});
 return {status:p.error||p.signal?1:p.status,saida:p.status===0?p.stdout:(p.stderr||p.stdout||String(p.signal||p.error))};
}
if(require.main===module){
 try{
  const a=process.argv.slice(2);assert.equal(a.length,3,'USO_RECUSADO');assert.equal(a[0],'--cutover-autorizado');assert.equal(a[1],'--backup');
  const r=sequencia(a[2],rodarNode);console.log(JSON.stringify(r,null,1));if(r.resultado!=='CUTOVER_BANCO_PASS')process.exitCode=2;
 }catch(e){console.error(String(e.message).slice(0,160));process.exitCode=1;}
}
module.exports={etapas,comando,sequencia};
