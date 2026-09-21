/* eslint-disable @typescript-eslint/no-require-imports -- Runner transacional CommonJS. */
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {setTimeout:pause}=require('node:timers/promises');
const {client,fixture,installPool,fingerprint,plano,ctx}=require('./pagamentos-test-support.cjs');
const s=require('../lib/pagamentos/services/pagamento.service.ts');
const agenda=require('../lib/disponibilidade/repositories/disponibilidade.repository.ts');
async function esperarBloqueio(monitor, pid, bloqueador) {
  const fim=Date.now()+4000;
  do {
    const row=(await monitor.query('SELECT pg_blocking_pids($1) AS pids',[pid])).rows[0];
    if(row.pids.includes(bloqueador))return;
    await pause(20);
  } while(Date.now()<fim);
  assert.fail('A segunda conexão deveria aguardar o lock da primeira.');
}
async function main() {
  const a=client(),b=client(),m=client();
  await a.connect();await b.connect();await m.connect();
  const before=await fingerprint(m);
  let pending;
  try {
    for(const kind of ['chave','referencia','agenda']) {
      await a.query('BEGIN');await b.query('BEGIN');
      await a.query("SET LOCAL lock_timeout='6s'");await b.query("SET LOCAL lock_timeout='6s'");
      installPool(a);const adminA=await require('./admin-test-support.cjs').autenticarTeste(a);
      installPool(b);const adminB=await require('./admin-test-support.cjs').autenticarTeste(b);
      const ctxA={...ctx,token:adminA.token,usuarioId:adminA.usuarioId},ctxB={...ctx,token:adminB.token,usuarioId:adminB.usuarioId};
      // Preparar datas distintas: a 019 já serializa escritas na agenda antes do pagamento.
      const fa=await fixture(a,{data:'2098-11-11'}),fb=await fixture(b,{data:'2098-11-12'});
      installPool(a);const da=(await s.criarPagamentoDoFechamento({fechamentoId:fa.fechamentoId,plano},ctx)).detalhe;
      installPool(b);const db=(await s.criarPagamentoDoFechamento({fechamentoId:fb.fechamentoId,plano},ctx)).detalhe;
      const key=randomUUID();
      const make=d=>({pagamentoId:d.pagamento.id,meioPagamento:'PIX',valorBruto:40,
        confirmarAgora:kind==='agenda',alocacoes:[{parcelaId:d.parcelas[0].id,valor:40}],
        ...(kind==='chave'?{chaveIdempotencia:key}:kind==='referencia'?{provedorCodigo:'TESTE',referenciaExterna:key}:{}),
      });
      installPool(a);await s.registrarRecebimentoPagamento(make(da),ctxA);
      installPool(b);pending=(async()=>{
        if(kind==='agenda') await b.query('UPDATE fechamentos SET data_evento=$2 WHERE id=$1',[fb.fechamentoId,fa.data]);
        return s.registrarRecebimentoPagamento(make(db),ctxB);
      })().then(value=>({value}),error=>({error}));
      await esperarBloqueio(m,b.processID,a.processID);
      await a.query('ROLLBACK');
      const result=await pending;pending=null;if(result.error)throw result.error;
      assert.equal(result.value.reutilizado,false);
      if(kind==='agenda')assert.equal(result.value.reserva.status,'CONFIRMADA');
      assert.equal((await b.query('SELECT count(*)::int AS n FROM pagamento_recebimentos WHERE pagamento_id=$1',[db.pagamento.id])).rows[0].n,1);
      await b.query('ROLLBACK');console.log(`OK: concorrência ${kind}; espera física observada, recuperação após rollback e apenas um recebimento.`);
    }
    // O bloqueio administrativo deve aguardar uma confirmação em andamento.
    await a.query('BEGIN');await b.query('BEGIN');await b.query("SET LOCAL lock_timeout='6s'");
    await agenda.adquirirLockConfirmacaoAgenda('2098-12-12',a);
    pending=agenda.criarBloqueioAgenda({data:'2098-12-12',diaInteiro:false,horarioInicio:'11:00',horarioFim:'15:00',motivo:'TESTE ROLLBACK'},b)
      .then(value=>({value}),error=>({error}));
    await esperarBloqueio(m,b.processID,a.processID);
    await a.query('ROLLBACK');const bloqueio=await pending;pending=null;if(bloqueio.error)throw bloqueio.error;
    assert.equal(bloqueio.value.ativo,true);await b.query('ROLLBACK');
    console.log('OK: bloqueio administrativo compartilha o lock transacional da confirmação.');
    // Caso real utilizado apenas para leitura e locks, sem UPDATE/INSERT.
    const rec=(await m.query(`SELECT r.id,c.fechamento_id FROM pagamento_recebimentos r JOIN pagamentos p ON p.id=r.pagamento_id
      JOIN contrato_versoes v ON v.id=p.contrato_versao_id JOIN contratos c ON c.id=v.contrato_id WHERE r.status='CONFIRMADO' LIMIT 1`)).rows[0];
    assert.ok(rec,'Requer recebimento confirmado para o teste de ordem dos locks (somente leitura).');
    await a.query('BEGIN');await b.query('BEGIN');await b.query("SET LOCAL lock_timeout='6s'");
    await a.query('SELECT id FROM fechamentos WHERE id=$1 FOR UPDATE',[rec.fechamento_id]);
    installPool(b);pending=s.confirmarRecebimentoPagamento(rec.id,ctx).then(value=>({value}),error=>({error}));
    await esperarBloqueio(m,b.processID,a.processID);
    await a.query('SELECT id FROM pagamento_recebimentos WHERE id=$1 FOR UPDATE NOWAIT',[rec.id]);
    await a.query('ROLLBACK');const confirmed=await pending;pending=null;if(confirmed.error)throw confirmed.error;
    assert.equal(confirmed.value.recebimento.status,'CONFIRMADO');await b.query('ROLLBACK');
    console.log('OK: confirmação aguarda Fechamento sem segurar recebimento; ordem de locks consistente.');
  } finally {
    await a.query('ROLLBACK');if(pending)await pending;await b.query('ROLLBACK');
    delete globalThis.__kidmaisPgPool;
    try{assert.deepEqual(await fingerprint(m),before);console.log('5 cenários concorrentes aprovados; fingerprint preservado.');}
    finally{await a.end();await b.end();await m.end();}
  }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
