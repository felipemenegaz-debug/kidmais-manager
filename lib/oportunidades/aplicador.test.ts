import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
test('aplicadores 122 conferem hashes offline e recusam aplicação local sem conectar',async()=>{
 for(const nome of ['staging','production']){
  const app=require(`../../scripts/migration-122-${nome}.cjs`);
  let conexoes=0;const deps={Client:class{constructor(){conexoes++;}}};
  const plano=await app.principal([],{},deps);assert.equal(plano.codigo,0);assert.equal(plano.saida.conecta,false);assert.equal(plano.saida.arquivos.length,3);
  await assert.rejects(app.principal(['--aplicar-122-autorizado','--backup','sintetico-20261114'],{},deps));assert.equal(conexoes,0);
 }
 const {modo,estado}=require('../../scripts/migration-122-comum.cjs');
 assert.throws(()=>modo(['--aplicar-122-autorizado']));assert.throws(()=>estado({a:true,m:false,r:false,f:false,c:false}));
});
// Astra 15/11/2026, P3: COMMIT respondido como ROLLBACK é DESFEITA_PELO_SERVIDOR (como no genérico), não INDETERMINADO.
test('aplicador 122 classifica a resposta do COMMIT',async()=>{
 const os=require('node:os'),fs=require('node:fs'),path=require('node:path');
 const {criarAplicador,SQL_ESTADO}=require('../../scripts/migration-122-comum.cjs');
 const casos:Array<[string,()=>unknown,string]>=[
  ['ROLLBACK sem erro',()=>({command:'ROLLBACK',rows:[]}),'DESFEITA_PELO_SERVIDOR'],
  ['erro do servidor com SQLSTATE comum',()=>{throw Object.assign(new Error('x'),{severity:'ERROR',code:'40001'});},'DESFEITA_PELO_SERVIDOR'],
  ['conexão caiu no COMMIT',()=>{throw Object.assign(new Error('x'),{code:'ECONNRESET',errno:-4077,syscall:'read'});},'INDETERMINADO'],
  ['COMMIT confirmado mas reconferência falhou',()=>({command:'COMMIT',rows:[]}),'CONFIRMADO'],
 ];
 for(const [nome,commit,esperado] of casos){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kidmais-122-'));
  try{
   // O primeiro COMMIT é o da conferência READ ONLY; o segundo é o da aplicação.
   let commits=0,commitou=false;
   const app=criarAplicador({nome:'teste',DIR:dir,alvo:()=>({}),exigirDisco:()=>{},identidade:()=>{},SQL_IDENTIDADE:'SELECT identidade'});
   const Client=class{on(){}async connect(){}async end(){}async query(sql:string){
    if(sql===SQL_ESTADO)return {rows:[commitou?{a:true,m:true,r:true,f:true,c:true}:{a:false,m:false,r:false,f:false,c:false}]};
    if(sql.includes('has_schema_privilege'))return {rows:[{uso:true,criar:true,dono:true,referencias:true}]};
    if(sql==='COMMIT'&&++commits===2){commitou=true;return commit();}
    if(commitou&&sql.includes('122: colunas divergentes'))throw Object.assign(new Error('RECONFERENCIA'),{severity:'ERROR',code:'P0001'});
    return {rows:[{}],command:'X'};
   }};
   const r=await app.principal(['--aplicar-122-autorizado','--backup','sintetico-20261115'],{},{Client});
   assert.equal(r.codigo,2,nome);assert.equal(r.saida.commit,esperado,nome);
   assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'migration-122.json'),'utf8')).commit,esperado,nome);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
 }
});
