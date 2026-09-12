/* eslint-disable @typescript-eslint/no-require-imports */
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const {Client}=require('pg');
async function main(){
 const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();
 try{
  assert.match((await c.query('SELECT current_database() banco')).rows[0].banco,/^kidmais_015_\d+$/);
  const admin=await require('./admin-test-support.cjs').autenticarTeste(c);
  const service=require('../lib/pagamentos/services/alteracao-financeira.service.ts');
  const core=require('../lib/pagamentos/services/alteracao-financeira-core.ts');
  const repo=require('../lib/pagamentos/repositories/alteracao-financeira.repository.ts');
  const {db,closeDatabasePool}=require('../lib/db/postgres.ts');
  const fid=(await c.query('SELECT contrato_id FROM contrato_pendencias_financeiras ORDER BY criado_em LIMIT 1')).rows[0].contrato_id;
  const context={token:admin.token,requestId:crypto.randomUUID(),ip:null,userAgent:'015 integration'};
  let p=await repo.lerPosicaoFinanceira(db(),fid);assert.equal(p.valorVigente,1313100n);assert.equal(p.posicao.liquido,849000n);
  const pend=p.pendencias.find(x=>x.versao_nova_id===p.vigente.id);
  const old=(await c.query('SELECT to_jsonb(p)::text row FROM pagamentos p ORDER BY id')).rows;
  const oldDocs=(await c.query('SELECT id,pdf_hash,encode(conteudo_pdf,\'hex\') bytes FROM contrato_documentos ORDER BY id')).rows;
  const first=await service.iniciarTratamento(fid,pend.id,p.posicaoHash,crypto.randomUUID(),context);
  await service.cancelarTratamento(fid,first.resultado.tratamentoId,'Operador cancelou apenas a tentativa',crypto.randomUUID(),context);
  p=await repo.lerPosicaoFinanceira(db(),fid);assert.equal(core.situacaoAlteracao(p.motivos.length>0,p.tratamentos.at(-1).estado),'PENDENTE');
  const started=await service.iniciarTratamento(fid,pend.id,p.posicaoHash,crypto.randomUUID(),context);
  p=await repo.lerPosicaoFinanceira(db(),fid);
  const input={posicaoHash:p.posicaoHash,modo:'MANTER_E_COMPLEMENTAR',parcelas:[...p.futuro.filter(i=>BigInt(i.valorCentavos)>0n).map(({parcelaId,valorCentavos,vencimento})=>({parcelaId,valorCentavos,vencimento})),{valorCentavos:'414100',vencimento:p.vigente.snapshot.evento.data}],credito:'NAO_SE_APLICA',decisaoContratante:'NAO_SE_APLICA',justificativa:'Complemento da versão vigente; saldo anterior preservado.'};
  const simulation=await service.simularAlteracao(fid,started.resultado.tratamentoId,input);assert.equal(simulation.depois.saldo,'464100');
  const chave=crypto.randomUUID();const done=await service.resolverAlteracao(fid,started.resultado.tratamentoId,input,chave,context);
  assert.equal(done.resultado.obrigacaoCentavos,'1313100');assert.equal(done.resultado.saldoCentavos,'464100');
  const retry=await service.resolverAlteracao(fid,started.resultado.tratamentoId,input,chave,context);assert.equal(retry.reutilizado,true);assert.deepEqual(retry.resultado,done.resultado);
  await assert.rejects(service.resolverAlteracao(fid,started.resultado.tratamentoId,{...input,justificativa:'outra intenção'},chave,context),{code:'IDEMPOTENCIA_CONFLITANTE'});
  assert.deepEqual((await c.query('SELECT to_jsonb(p)::text row FROM pagamentos p ORDER BY id')).rows,old);
  assert.deepEqual((await c.query('SELECT id,pdf_hash,encode(conteudo_pdf,\'hex\') bytes FROM contrato_documentos ORDER BY id')).rows,oldDocs);
  p=await repo.lerPosicaoFinanceira(db(),fid);assert.equal(p.futuro.reduce((a,i)=>a+BigInt(i.valorCentavos),0n),464100n);
  console.log('PASSOU: cancelamento de tentativa, aumento parcial real, cronograma misto, repetição idempotente, rejeição de intenção divergente, obrigação original e PDFs intactos.');
  await closeDatabasePool();
 }finally{await c.end();}
}
main().catch(e=>{console.error(e);process.exitCode=1;setTimeout(()=>process.exit(1),100);});
