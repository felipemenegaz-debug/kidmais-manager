/* eslint-disable @typescript-eslint/no-require-imports */
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {setTimeout:pause}=require('node:timers/promises');
const {Client}=require('pg');
module.exports=async function testes({c,admin,festa,payment,receber,nova,fresh,freeze,accessFor,edition,op,occupied,ok}){
 const {installPool}=require('./pagamentos-test-support.cjs');
 const cs=require('../lib/contratos/services/administrativo.service.ts'),publico=require('../lib/contratos/services/contrato-publico.service.ts'),agenda=require('../lib/disponibilidade/repositories');
 const second=await require('./admin-test-support.cjs').autenticarTeste(c);
 const pool=globalThis.__kidmaisPgPool;
 const ca=new Client({connectionString:process.env.DATABASE_URL}),cb=new Client({connectionString:process.env.DATABASE_URL});await ca.connect();await cb.connect();
 const ctx=()=>({requestId:randomUUID(),ip:null,userAgent:'Concorrência 014 com barreira PostgreSQL'});
 const act=(vid,input,token)=>cs.operarContrato(vid,input,token,ctx());
 async function wait(){const limit=Date.now()+5000;while(Date.now()<limit){const row=(await c.query('SELECT pg_blocking_pids($1) pids',[cb.processID])).rows[0];if(row.pids.includes(ca.processID))return;await pause(15);}throw Error('Barreira: conexão B não aguardou fisicamente conexão A.');}
 async function race(first,last,{firstCommit=true,secondFails=true}={}){
  let pending;await ca.query('BEGIN');await cb.query('BEGIN');await cb.query("SET LOCAL lock_timeout='7s'");
  try{installPool(ca);await first(ca);await ca.query('SET CONSTRAINTS ALL IMMEDIATE');installPool(cb);pending=last(cb).then(value=>({value}),error=>({error}));await wait();await ca.query(firstCommit?'COMMIT':'ROLLBACK');const done=await pending;pending=null;if(secondFails)assert(done.error,'A segunda operação deve recusar após observar o vencedor');else if(done.error)throw done.error;if(done.error)await cb.query('ROLLBACK');else{await cb.query('SET CONSTRAINTS ALL IMMEDIATE');await cb.query('COMMIT');}return done;}
  finally{await ca.query('ROLLBACK');if(pending)await pending;await cb.query('ROLLBACK');globalThis.__kidmaisPgPool=pool;}
 }
 try{
  const fa=await festa('2096-09-12'),fb=await festa('2096-09-13');await receber(await payment(fa));await receber(await payment(fb));const va=await nova(fa),vb=await nova(fb);
  const ia=await fresh(va,{dataEvento:'2096-09-19'}),ib=await fresh(vb,{dataEvento:'2096-09-19'});
  await race(()=>act(va,ia,admin.token),()=>act(vb,ib,second.token));assert.equal((await occupied('2096-09-19',fa.fid)).length,1);assert.equal((await occupied('2096-09-19',fb.fid)).length,0);ok('concorrência: duas revisões, conexões/sessões distintas e barreira física; um hold vencedor');
  const novo=await fresh(vb,{dataEvento:'2096-09-20'});
  await race(tx=>agenda.criarBloqueioAgenda({data:'2096-09-20',diaInteiro:true,motivo:'Concorrência bloco primeiro'},tx),()=>act(vb,novo,second.token));assert.equal((await occupied('2096-09-13',fb.fid)).length,2);ok('concorrência: bloqueio administrativo vence; revisão aguarda e preserva destino anterior');
  await race(()=>act(vb,{...novo,dataEvento:'2096-09-21'},admin.token),tx=>agenda.criarBloqueioAgenda({data:'2096-09-21',diaInteiro:true,motivo:'Concorrência revisão primeiro'},tx));ok('concorrência: revisão vence; bloqueio aguarda e recusa sobreposição');
  // A mudança de destino só se torna visível por inteiro no commit.
  const move=await fresh(vb,{dataEvento:'2096-09-22'});await ca.query('BEGIN');installPool(ca);await act(vb,move,admin.token);await ca.query('SET CONSTRAINTS ALL IMMEDIATE');assert.equal((await occupied('2096-09-21',fb.fid)).length,1);assert.equal((await occupied('2096-09-22',fb.fid)).length,0);await ca.query('ROLLBACK');globalThis.__kidmaisPgPool=pool;assert.equal((await occupied('2096-09-21',fb.fid)).length,1);ok('concorrência: observador não vê liberação parcial; rollback restaura hold antigo');
  for(const aceitaPrimeiro of [true,false]){
   const f=await festa(aceitaPrimeiro?'2096-10-10':'2096-10-11'),v=await nova(f);await freeze(v);const acesso=await accessFor(v);const cancelar={acao:'cancelar_revisao',revisao:(await edition(v)).revisao,motivo:'Concorrência aceite/cancelamento'};
   await race(()=>aceitaPrimeiro?publico.assinarContratoPublico(acesso.input,acesso.sender):act(v,cancelar,admin.token),()=>aceitaPrimeiro?act(v,cancelar,second.token):publico.assinarContratoPublico(acesso.input,acesso.sender));
   const r=(await c.query('SELECT estado FROM fechamento_revisoes WHERE contrato_versao_id=$1',[v])).rows[0];assert.equal(r.estado,aceitaPrimeiro?'APLICADA':'CANCELADA');const provas=(await c.query("SELECT count(*)::int n FROM contrato_assinaturas WHERE contrato_versao_id=$1 AND parte='CLIENTE'",[v])).rows[0].n;assert.equal(provas,aceitaPrimeiro?1:0);ok(`concorrência: ${aceitaPrimeiro?'aceite':'cancelamento'} vence; perdedor sem prova/aplicação parcial`);
  }
  for(const editarPrimeiro of [true,false]){
   const f=await festa(editarPrimeiro?'2096-11-10':'2096-11-11'),v=await nova(f);const e=await edition(v),pdf=await op(v,{acao:'gerar_pdf',revisao:e.revisao});await op(v,{acao:'revisar',revisao:e.revisao,documentoId:pdf.documentoId});const assinar={acao:'assinar',revisao:e.revisao,documentoId:pdf.documentoId,chaveIdempotencia:randomUUID()},editar=await fresh(v,{convidados:60});
   await race(()=>act(v,editarPrimeiro?editar:assinar,admin.token),()=>act(v,editarPrimeiro?assinar:editar,second.token));assert.equal((await c.query('SELECT estado FROM fechamento_revisoes WHERE contrato_versao_id=$1',[v])).rows[0].estado,editarPrimeiro?'EM_ELABORACAO':'CONGELADA');ok(`concorrência: ${editarPrimeiro?'edição':'congelamento'} vence; revisão obsoleta recusada`);
  }
  const ultimo=await fresh(vb,{dataEvento:'2096-12-20'});
  await race(()=>act(vb,ultimo,admin.token),tx=>agenda.criarBloqueioAgenda({data:'2096-12-20',diaInteiro:true,motivo:'Recuperação depois de rollback'},tx),{firstCommit:false,secondFails:false});assert.equal((await occupied('2096-09-21',fb.fid)).length,1);ok('concorrência: perdedor recupera após rollback real do primeiro sem hold fantasma');

  const bloqueio=(await c.query("SELECT id FROM bloqueios_agenda WHERE data='2096-12-20' AND ativo")).rows[0];const liberada=await fresh(vb,{dataEvento:'2096-12-20'});
  await race(tx=>agenda.desativarBloqueioAgendaPorId(bloqueio.id,tx),()=>act(vb,liberada,second.token),{secondFails:false});ok('concorrência: desativação por ID compartilha lock; revisão só adquire destino após commit');
  await agenda.criarBloqueioAgenda({data:'2096-12-21',diaInteiro:false,horarioInicio:'17:00',horarioFim:'21:00',motivo:'Desativação exata'});const exata=await fresh(vb,{dataEvento:'2096-12-21'});
  await race(tx=>agenda.desativarBloqueiosExatos({data:'2096-12-21',horarioInicio:'17:00',horarioFim:'21:00'},tx),()=>act(vb,exata,second.token),{secondFails:false});ok('concorrência: desativação de intervalo exato segue o mesmo protocolo');
 }finally{globalThis.__kidmaisPgPool=pool;await ca.query('ROLLBACK');await cb.query('ROLLBACK');await ca.end();await cb.end();}
};
