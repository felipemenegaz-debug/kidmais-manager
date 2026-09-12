/* eslint-disable @typescript-eslint/no-require-imports */
const assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {rollbackTest}=require('./pagamentos-test-support.cjs'),{NextRequest}=require('next/server');
const route=require('../app/api/admin/contratos/[contratoId]/financeiro/[[...acao]]/route.ts');
rollbackTest(async c=>{
 assert.match((await c.query('SELECT current_database() banco')).rows[0].banco,/^kidmais_015_\d+$/);
 const admin=await require('./admin-test-support.cjs').autenticarTeste(c);
 // Independente das pendências reais, que podem já ter sido resolvidas manualmente.
 const {fixtureFinanceiro,promover}=require('./financeiro-015-test-support.cjs');
 const fixture=await fixtureFinanceiro(c,{token:admin.token,usuarioId:admin.usuarioId,origem:'TESTE_ISOLADO',requestId:randomUUID()},0);
 await promover(c,fixture,150);
 const id=fixture.contratoId;
 let count=0;
 async function call(acao=[],body,expected=200,headers={},key=randomUUID()){
  const method=body===undefined?'GET':'POST',r=await route[method](new NextRequest('http://localhost:3000/api/admin/contratos/'+id+'/financeiro/'+acao.join('/'),{method,headers:{...admin.headers(),'Idempotency-Key':key,...headers},...(body===undefined?{}:{body:JSON.stringify(body)})}),{params:Promise.resolve({contratoId:id,acao})});
  const b=await r.json();assert.equal(r.status,expected,JSON.stringify(b));assert.equal(r.headers.get('Cache-Control'),'no-store');count++;return b.data;
 }
 await call([],undefined,401,{cookie:''});
 const initial=(await call()).painel,pend=initial.pendencias.find(x=>x.versao_nova_id===initial.vigente.id);
 await call(['pendencias',pend.id,'tratamentos'],{posicaoHash:initial.posicaoHash},403,{'x-csrf-token':'forjado'});
 await call(['pendencias',pend.id,'tratamentos'],{posicaoHash:initial.posicaoHash},400,{},'invalida');
 await call(['pendencias',pend.id,'tratamentos'],{posicaoHash:initial.posicaoHash,papel:'REPRESENTANTE_AUTORIZADO'},400);
 const t=(await call(['pendencias',pend.id.toUpperCase(),'tratamentos'],{posicaoHash:initial.posicaoHash})).resultado.tratamentoId;
 await call(['tratamentos',t,'cancelar'],{motivo:'Cancelamento de tentativa HTTP'});
 const after=(await call()).painel;assert.equal(after.pendencias.find(x=>x.id===pend.id).situacao,'PENDENTE');
 const t2=(await call(['pendencias',pend.id,'tratamentos'],{posicaoHash:after.posicaoHash})).resultado.tratamentoId;
 const p=(await call()).painel,saldo=BigInt(p.valorVigente)-BigInt(p.posicao.liquido),b={posicaoHash:p.posicaoHash,modo:'REPROGRAMAR',parcelas:[{valorCentavos:saldo.toString(),vencimento:p.vigente.snapshot.evento.data}],credito:'NAO_SE_APLICA',decisaoContratante:'NAO_SE_APLICA',justificativa:'Integração HTTP com autenticação real'};
 await call(['tratamentos',t2,'simulacao'],{...b,parcelas:[{...b.parcelas[0],valorCentavos:'1.001'}]},400);
 await call(['tratamentos',t2,'simulacao'],{...b,parcelas:[{...b.parcelas[0],valorCentavos:true}]},400);
 await call(['tratamentos',t2,'simulacao'],{...b,parcelas:[{...b.parcelas[0],valorCentavos:'1'}]},422);
 await call(['tratamentos',t2,'simulacao'],b);
 const key=randomUUID(),done=await call(['tratamentos',t2,'resolver'],b,200,{},key),retry=await call(['tratamentos',t2,'resolver'],b,200,{},key.toUpperCase());assert.equal(retry.reutilizado,true);assert.deepEqual(retry.resultado,done.resultado);
 await call(['tratamentos',t2,'resolver'],{...b,justificativa:'Intenção diferente'},409,{},key);
 const final=(await call()).painel;assert.equal(final.pendencias.find(x=>x.id===pend.id).situacao,'RESOLVIDA');assert.equal(final.pagamento.valor_total_contratado,initial.pagamento.valor_total_contratado);
 await call(['devolucoes'],{posicaoHash:final.posicaoHash,valorCentavos:'1',beneficiario:{nome:'Teste'},motivo:'Sem crédito',origens:[{alocacaoId:randomUUID(),valorCentavos:'1'}]},409);
 await call(['inexistente'],undefined,404);
 // A fixture financeira não fabrica assinaturas/edições; valida as constraints do domínio sob teste.
 await c.query('SET CONSTRAINTS p015_validar,p015_validar_movimento IMMEDIATE');
 console.log(`${count} requisições novas aprovadas: autenticação, CSRF, validação, cancelamento, simulação, resolução, UUID/idempotência, estado e ausência de crédito. Rollback integral.`);
}).catch(e=>{console.error(e);process.exitCode=1;});
