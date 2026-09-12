/* eslint-disable @typescript-eslint/no-require-imports */
const assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {client,installPool}=require('./pagamentos-test-support.cjs');
async function main(){
 const c=client();await c.connect();
 try{
  assert.match((await c.query('SELECT current_database() banco')).rows[0].banco,/^kidmais_015_\d+$/);
  await c.query('BEGIN');installPool(c);
  const admin=await require('./admin-test-support.cjs').autenticarTeste(c);
  const ctx={token:admin.token,usuarioId:admin.usuarioId,origem:'INTEGRACAO_015',requestId:randomUUID()};
  const {db}=require('../lib/db/postgres.ts'),repo=require('../lib/pagamentos/repositories/alteracao-financeira.repository.ts'),s=require('../lib/pagamentos/services/pagamento.service.ts');
  const id=(await c.query('SELECT contrato_id FROM pagamento_gestoes g WHERE EXISTS(SELECT 1 FROM pagamento_ajustes_contratuais a WHERE a.pagamento_id=g.pagamento_id) LIMIT 1')).rows[0].contrato_id;
  let p=await repo.lerPosicaoFinanceira(db(),id);
  const old=(await c.query('SELECT to_jsonb(p)::text row FROM pagamentos p ORDER BY id')).rows;
  const oldParcelas=(await c.query('SELECT to_jsonb(p)::text row FROM pagamento_parcelas p ORDER BY id')).rows;
  const alvo=p.futuro.find(x=>BigInt(x.valorCentavos)>0n);assert.ok(alvo);
  const input={pagamentoId:p.pagamento.id,valorBruto:1,meioPagamento:'PIX',chaveIdempotencia:randomUUID(),alocacoes:[{parcelaId:alvo.parcelaId,valor:1}]};
  const receipt=await s.registrarRecebimentoPagamento(input,ctx);assert.equal(receipt.recebimento.status,'CONFIRMADO');
  assert.equal(receipt.detalhe.fonteProgramacao,'CRONOGRAMA_CONSOLIDADO');
  const retry=await s.registrarRecebimentoPagamento(input,ctx);assert.equal(retry.reutilizado,true);
  let after=await repo.lerPosicaoFinanceira(db(),id);assert.equal(after.posicao.saldo,p.posicao.saldo-100n);
  const estorno=await s.registrarEstornoPagamento({pagamentoId:p.pagamento.id,recebimentoId:receipt.recebimento.id,parcelaId:alvo.parcelaId,valor:1,motivo:'Integração estorno real',chaveIdempotencia:randomUUID()},ctx);assert.equal(estorno.estorno.status,'CONFIRMADO');
  after=await repo.lerPosicaoFinanceira(db(),id);assert.equal(after.posicao.saldo,p.posicao.saldo);
  assert.deepEqual((await c.query('SELECT to_jsonb(p)::text row FROM pagamentos p ORDER BY id')).rows,old);
  assert.deepEqual((await c.query('SELECT to_jsonb(p)::text row FROM pagamento_parcelas p ORDER BY id')).rows,oldParcelas);
  assert.equal((await c.query('SELECT count(*)::int n FROM pagamento_movimentos_contextos WHERE recebimento_id=$1 OR estorno_id=$2',[receipt.recebimento.id,estorno.estorno.id])).rows[0].n,2);
  await c.query('SET CONSTRAINTS ALL IMMEDIATE');
  console.log('PASS: recebimento consolidado, parcela preservada, idempotência, estorno, eventos/contextos e histórico imutável; rollback integral.');
 }finally{await c.query('ROLLBACK');delete globalThis.__kidmaisPgPool;await c.end();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
