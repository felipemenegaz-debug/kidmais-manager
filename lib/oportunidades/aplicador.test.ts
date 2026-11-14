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
