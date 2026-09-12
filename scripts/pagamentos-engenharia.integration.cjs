/* eslint-disable @typescript-eslint/no-require-imports -- Testes CommonJS carregam serviços TypeScript reais. */
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { rollbackTest, fixture, ctx, plano } = require('./pagamentos-test-support.cjs');
const s = require('../lib/pagamentos/services/pagamento.service.ts');
const r = require('../lib/pagamentos/repositories/pagamento.repository.ts');
const agenda = require('../lib/disponibilidade/repositories/disponibilidade.repository.ts');
let checks = 0;
async function caso(c, nome, fn) {
  await c.query('SAVEPOINT caso');
  try { await fn(); checks++; console.log('OK:', nome); }
  finally { await c.query('ROLLBACK TO SAVEPOINT caso'); }
}
const erro = (promise, code) => assert.rejects(promise, { code });
const receber = (d, valor, numero = 0, extra = {}) => s.registrarRecebimentoPagamento({
  pagamentoId: d.pagamento.id, meioPagamento: 'PIX', valorBruto: valor,
  alocacoes: [{ parcelaId: d.parcelas[numero].id, valor }], ...extra,
}, ctx);
async function evento(c, id, nome) {
  for (const [t,col] of [['auditoria','acao'],['eventos_historico_cliente','tipo_evento']])
    assert.equal((await c.query(`SELECT count(*)::int AS n FROM ${t} WHERE entidade_id=$1 AND ${col}=$2`,[id,nome])).rows[0].n,1);
}
async function main(c) {
  const f = await fixture(c);
  assert.equal((await c.query('SELECT count(*)::int AS n FROM pagamentos WHERE contrato_versao_id=$1',[f.versaoId])).rows[0].n,0);
  const criar = () => s.criarPagamentoDoFechamento({ fechamentoId: f.fechamentoId, plano }, ctx);
  for (const [nome, sql, code] of [
    ['contrato não assinado', "UPDATE contratos SET status='AGUARDANDO_ASSINATURA' WHERE id=$1", 'CONTRATO_NAO_ASSINADO'],
    ['versão corrente divergente', 'UPDATE contratos SET versao_atual=2 WHERE id=$1', 'VERSAO_CONTRATUAL_NAO_ASSINADA'],
  ]) await caso(c,nome,async()=>{await c.query(sql,[f.contratoId]);await erro(criar(),code);});
  await caso(c,'fechamento incompatível',async()=>{await c.query("UPDATE fechamentos SET status='CANCELADO' WHERE id=$1",[f.fechamentoId]);await erro(criar(),'STATUS_FECHAMENTO_NAO_PERMITE_PAGAMENTO');});
  const d = (await criar()).detalhe;
  await caso(c,'segunda passagem: UUIDs reais equivalentes e duplicatas com caixa diferente',async()=>{
    const key=randomUUID();const a=await receber(d,10,0,{chaveIdempotencia:key});
    const b=await receber(d,10,0,{pagamentoId:d.pagamento.id.toUpperCase(),chaveIdempotencia:key,alocacoes:[{parcelaId:d.parcelas[0].id.toUpperCase(),valor:10}]});
    assert.equal(b.recebimento.id,a.recebimento.id);assert.equal(b.reutilizado,true);
    await erro(receber(d,10,0,{alocacoes:[{parcelaId:d.parcelas[0].id,valor:5},{parcelaId:d.parcelas[0].id.toUpperCase(),valor:5}]}),'ALOCACAO_INVALIDA');
    const est={pagamentoId:d.pagamento.id,recebimentoId:a.recebimento.id,parcelaId:d.parcelas[0].id,valor:1,chaveIdempotencia:randomUUID()};
    const e=await s.registrarEstornoPagamento(est,ctx);
    assert.equal((await s.registrarEstornoPagamento({...est,pagamentoId:est.pagamentoId.toUpperCase(),recebimentoId:est.recebimentoId.toUpperCase(),parcelaId:est.parcelaId.toUpperCase()},ctx)).estorno.id,e.estorno.id);
  });
  await caso(c,'segunda passagem: centavos válidos somam sem resíduos e subcentavos não persistem',async()=>{
    await receber(d,0.1);await receber(d,0.2);
    const result=await receber(d,0.29);assert.equal(result.detalhe.totais.recebidoLiquido,0.59);
    assert.equal(result.detalhe.parcelas[0].saldo,39.41);
    await erro(receber(d,1.0000000001),'PLANO_PAGAMENTO_INVALIDO');
  });
  await caso(c,'criação explícita e idempotente',async()=>{
    assert.equal((await criar()).reutilizado,true);
    assert.equal((await c.query('SELECT status FROM fechamentos WHERE id=$1',[f.fechamentoId])).rows[0].status,'AGUARDANDO_PAGAMENTO');
    await erro(s.criarPagamentoDoFechamento({fechamentoId:f.fechamentoId,plano:{...plano,meioPagamento:'CARTAO'}},ctx),'PAGAMENTO_JA_EXISTE');
  });
  await caso(c,'recebimento opera na obrigação original e rejeita fechamento incompatível e pagamento cancelado',async()=>{
    await c.query('SAVEPOINT estado');
    await c.query('UPDATE contratos SET versao_atual=2 WHERE id=$1',[f.contratoId]);
    assert.equal((await receber(d,1)).recebimento.pagamentoId,d.pagamento.id);await c.query('ROLLBACK TO SAVEPOINT estado');
    await c.query("UPDATE fechamentos SET status='EXPIRADO' WHERE id=$1",[f.fechamentoId]);
    await erro(receber(d,1),'STATUS_FECHAMENTO_NAO_PERMITE_PAGAMENTO');await c.query('ROLLBACK TO SAVEPOINT estado');
    await c.query("UPDATE pagamentos SET status='CANCELADO',cancelado_em=now() WHERE id=$1",[d.pagamento.id]);
    await erro(receber(d,1),'PAGAMENTO_CANCELADO');
  });
  await caso(c,'restrições físicas rejeitam status impossível e pagamento duplicado',async()=>{
    for(const sql of ["UPDATE pagamentos SET status='INVENTADO' WHERE id=$1", "UPDATE pagamentos SET status='QUITADO',quitado_em=NULL WHERE id=$1"]) {
      await c.query('SAVEPOINT invalido');await assert.rejects(c.query(sql,[d.pagamento.id]),{code:'23514'});await c.query('ROLLBACK TO SAVEPOINT invalido');
    }
    await c.query('SAVEPOINT duplicado');await assert.rejects(r.criarPagamento({contratoVersaoId:f.versaoId,valorTotalContratado:100},c),{code:'23505'});await c.query('ROLLBACK TO SAVEPOINT duplicado');
  });
  await caso(c,'versionamento preserva V1 e gera auditoria e histórico',async()=>{
    const v2=await s.substituirPlanoPagamento(d.pagamento.id,{...plano,meioPagamento:'CARTAO',provedorPreferido:'CIELO'},'Teste de alteração',ctx);
    assert.equal(v2.plano.numeroVersao,2);
    assert.equal((await r.listarParcelasPlano(d.plano.id,c))[0].status,'CANCELADA');
    await evento(c,d.pagamento.id,'PLANO_PAGAMENTO_SUBSTITUIDO');
    await erro(receber(d,1),'PARCELA_NAO_ENCONTRADA');
  });
  await caso(c,'alocação inválida e overpayment não persistem',async()=>{
    await erro(receber(d,41),'VALOR_EXCEDE_SALDO');
    await erro(receber(d,41,0,{confirmarAgora:false}),'VALOR_EXCEDE_SALDO');
    await erro(receber(d,10,0,{alocacoes:[{parcelaId:d.parcelas[0].id,valor:9}]}),'ALOCACAO_INVALIDA');
    await erro(receber(d,10,0,{alocacoes:[{parcelaId:d.parcelas[0].id,valor:5},{parcelaId:d.parcelas[0].id,valor:5}]}),'ALOCACAO_INVALIDA');
    assert.equal((await c.query('SELECT count(*)::int AS n FROM pagamento_recebimentos WHERE pagamento_id=$1',[d.pagamento.id])).rows[0].n,0);
  });
  for(const status of ['PENDENTE','CONFIRMADO','RECUSADO','CANCELADO']) await caso(c,`plano bloqueado após recebimento ${status}`,async()=>{
    const rec=await receber(d,1,0,{confirmarAgora:false});
    await r.marcarRecebimentoStatus(rec.recebimento.id,status,c);
    await erro(s.substituirPlanoPagamento(d.pagamento.id,plano,'Teste',ctx),'PLANO_NAO_PODE_SER_SUBSTITUIDO');
  });
  await caso(c,'recebimento pendente revalida saldo na confirmação',async()=>{
    const a=await receber(d,30,0,{confirmarAgora:false});await receber(d,20);
    await erro(s.confirmarRecebimentoPagamento(a.recebimento.id,ctx),'VALOR_EXCEDE_SALDO');
    assert.equal((await r.buscarRecebimentoPorId(a.recebimento.id,c)).status,'PENDENTE');
  });
  await caso(c,'idempotência por chave e por provedor/referência',async()=>{
    const extra={chaveIdempotencia:randomUUID(),provedorCodigo:'TESTE',referenciaExterna:randomUUID()};
    const a=await receber(d,10,0,{...extra,confirmarAgora:false});
    await evento(c,a.recebimento.id,'RECEBIMENTO_REGISTRADO');
    const b=await receber(d,10,0,{...extra,chaveIdempotencia:` ${extra.chaveIdempotencia} `});
    assert.equal(b.recebimento.id,a.recebimento.id);assert.equal(b.recebimento.status,'CONFIRMADO');
    assert.equal((await receber(d,10,0,{...extra,chaveIdempotencia:undefined})).reutilizado,true);
    await erro(receber(d,11,0,extra),'RECEBIMENTO_INVALIDO');
    await erro(receber(d,10,0,{...extra,referenciaExterna:'outra'}),'RECEBIMENTO_INVALIDO');
  });
  await caso(c,'violação de unicidade concorrente recebe resposta HTTP 409',async()=>{
    const chave=randomUUID();await receber(d,1,0,{chaveIdempotencia:chave});
    await c.query('SAVEPOINT corrida');let conflict;
    try {await r.criarRecebimento({pagamentoId:d.pagamento.id,meioPagamento:'PIX',valorBruto:1,chaveIdempotencia:chave},c);}
    catch(e){conflict=e;}
    await c.query('ROLLBACK TO SAVEPOINT corrida');assert.equal(conflict?.code,'23505');
    const response=require('../lib/http/pagamentos-api.ts').erroPagamentoApi(conflict);
    assert.equal(response.status,409);assert.equal((await response.json()).codigo,'OPERACAO_FINANCEIRA_DUPLICADA');
  });
  await caso(c,'fluxo parcial, reserva, quitação, estorno e histórico',async()=>{
    assert.equal((await receber(d,10)).detalhe.pagamento.reservaStatus,'PENDENTE');
    const qualifica=await receber(d,30);assert.equal(qualifica.reserva.status,'CONFIRMADA');
    assert.equal(qualifica.detalhe.pagamento.status,'PARCIALMENTE_PAGO');
    const total=await receber(d,60,1);assert.equal(total.detalhe.pagamento.status,'QUITADO');
    const quitadoEm=total.detalhe.pagamento.quitadoEm; assert.ok(quitadoEm);
    const est={pagamentoId:d.pagamento.id,recebimentoId:total.recebimento.id,parcelaId:d.parcelas[1].id,valor:5,chaveIdempotencia:randomUUID(),provedorCodigo:'TESTE',referenciaExterna:randomUUID()};
    const e=await s.registrarEstornoPagamento(est,ctx);
    assert.equal(e.detalhe.pagamento.status,'PARCIALMENTE_PAGO');assert.equal(e.detalhe.totais.saldo,5);
    assert.equal(e.detalhe.pagamento.quitadoEm,quitadoEm);assert.equal(e.detalhe.pagamento.reservaStatus,'CONFIRMADA');
    assert.equal((await c.query('SELECT status FROM fechamentos WHERE id=$1',[f.fechamentoId])).rows[0].status,'CONFIRMADO');
    assert.equal((await s.registrarEstornoPagamento({...est,chaveIdempotencia:undefined},ctx)).estorno.id,e.estorno.id);
    await erro(s.registrarEstornoPagamento({...est,valor:6},ctx),'ESTORNO_INVALIDO');
    await erro(s.registrarEstornoPagamento({...est,valor:56,chaveIdempotencia:randomUUID(),referenciaExterna:randomUUID()},ctx),'ESTORNO_INVALIDO');
    await evento(c,e.estorno.id,'ESTORNO_CONFIRMADO');
    await erro(s.substituirPlanoPagamento(d.pagamento.id,plano,'Teste',ctx),'PLANO_NAO_PODE_SER_SUBSTITUIDO');
  });
  await caso(c,'estorno solicitado reserva limite e confirmação posterior é idempotente',async()=>{
    const rec=await receber(d,10);
    const est={pagamentoId:d.pagamento.id,recebimentoId:rec.recebimento.id,parcelaId:d.parcelas[0].id,valor:10,chaveIdempotencia:randomUUID()};
    const pending=await s.registrarEstornoPagamento({...est,confirmarAgora:false},ctx);assert.equal(pending.estorno.status,'SOLICITADO');
    assert.equal(pending.detalhe.totais.estornadoConfirmado,0);await evento(c,pending.estorno.id,'ESTORNO_SOLICITADO');
    await erro(s.registrarEstornoPagamento({...est,chaveIdempotencia:randomUUID(),valor:1},ctx),'ESTORNO_INVALIDO');
    const confirmed=await s.registrarEstornoPagamento(est,ctx);assert.equal(confirmed.estorno.id,pending.estorno.id);assert.equal(confirmed.estorno.status,'CONFIRMADO');
    assert.equal(confirmed.detalhe.pagamento.status,'ESTORNADO');
    assert.equal((await s.registrarEstornoPagamento(est,ctx)).reutilizado,true);
    await erro(s.registrarEstornoPagamento({...est,chaveIdempotencia:randomUUID(),valor:1},ctx),'ESTORNO_INVALIDO');
  });
  await caso(c,'estorno exige recebimento confirmado e alocação própria',async()=>{
    const rec=await receber(d,10,0,{confirmarAgora:false});
    const est={pagamentoId:d.pagamento.id,recebimentoId:rec.recebimento.id,parcelaId:d.parcelas[0].id,valor:1};
    await erro(s.registrarEstornoPagamento(est,ctx),'ESTORNO_INVALIDO');
    await s.confirmarRecebimentoPagamento(rec.recebimento.id,ctx);
    await erro(s.registrarEstornoPagamento({...est,parcelaId:d.parcelas[1].id},ctx),'ESTORNO_INVALIDO');
  });
  await caso(c,'estorno preserva pagamento cancelado e rejeita repetição em outro pagamento',async()=>{
    const rec=await receber(d,10);const est={pagamentoId:d.pagamento.id,recebimentoId:rec.recebimento.id,parcelaId:d.parcelas[0].id,valor:1,chaveIdempotencia:randomUUID()};
    await c.query("UPDATE pagamentos SET status='CANCELADO',cancelado_em=now() WHERE id=$1",[d.pagamento.id]);
    assert.equal((await s.registrarEstornoPagamento(est,ctx)).detalhe.pagamento.status,'CANCELADO');
    const f2=await fixture(c,{data:'2098-12-01'});const p2=(await s.criarPagamentoDoFechamento({fechamentoId:f2.fechamentoId,plano},ctx)).detalhe.pagamento;
    await erro(s.registrarEstornoPagamento({...est,pagamentoId:p2.id},ctx),'ESTORNO_INVALIDO');
  });
  await caso(c,'comprovante reutilizado sem duplicar auditoria e sem cruzar pagamentos',async()=>{
    const rec=await receber(d,1);const other=await fixture(c,{data:'2098-10-11'});const od=(await s.criarPagamentoDoFechamento({fechamentoId:other.fechamentoId,plano},ctx)).detalhe;
    const input={pagamentoId:d.pagamento.id,recebimentoId:rec.recebimento.id,nomeArquivo:'teste.pdf',mimeType:'application/pdf',tamanhoBytes:10,sha256:'a'.repeat(64),localizadorArquivo:'test-fixture://comprovante'};
    const a=await s.registrarComprovantePagamento(input,ctx);const b=await s.registrarComprovantePagamento(input,ctx);assert.equal(a.id,b.id);assert.equal(b.reutilizado,true);
    assert.equal((await c.query('SELECT count(*)::int AS n FROM auditoria WHERE entidade_id=$1',[a.id])).rows[0].n,1);
    await erro(s.registrarComprovantePagamento({...input,pagamentoId:od.pagamento.id},ctx),'COMPROVANTE_INVALIDO');
    await erro(s.registrarComprovantePagamento({...input,tamanhoBytes:11},ctx),'COMPROVANTE_INVALIDO');
    await erro(s.registrarComprovantePagamento({...input,tamanhoBytes:0},ctx),'COMPROVANTE_INVALIDO');
  });
  await caso(c,'agenda em conflito preserva dinheiro, auditoria e histórico',async()=>{
    await agenda.criarBloqueioAgenda({data:f.data,diaInteiro:false,horarioInicio:'14:00',horarioFim:'16:00',motivo:'TESTE ROLLBACK'},c);
    const rec=await receber(d,40);assert.equal(rec.reserva.status,'CONFLITO');assert.equal(rec.recebimento.status,'CONFIRMADO');assert.equal(rec.detalhe.totais.recebidoLiquido,40);
    assert.equal((await c.query('SELECT status FROM fechamentos WHERE id=$1',[f.fechamentoId])).rows[0].status,'AGUARDANDO_PAGAMENTO');
    await evento(c,d.pagamento.id,'PAGAMENTO_RECEBIDO_CONFLITO_AGENDA');
    assert.equal((await receber(d,60,1)).reserva.status,'CONFLITO');
    const refunded=await s.registrarEstornoPagamento({pagamentoId:d.pagamento.id,recebimentoId:rec.recebimento.id,parcelaId:d.parcelas[0].id,valor:40},ctx);
    assert.equal(refunded.detalhe.pagamento.reservaStatus,'CONFLITO');
  });
  await caso(c,'reservas sobrepostas conflitam; bordas adjacentes permanecem livres',async()=>{
    await receber(d,40);
    for(const [inicio,fim,esperado] of [['14:00','18:00','CONFLITO'],['15:00','19:00','CONFIRMADA']]) {
      const f2=await fixture(c,{data:f.data,inicio,fim});const d2=(await s.criarPagamentoDoFechamento({fechamentoId:f2.fechamentoId,plano},ctx)).detalhe;
      assert.equal((await receber(d2,40)).reserva.status,esperado);
    }
  });
}
rollbackTest(main).then(()=>console.log(`${checks} cenários aprovados; fingerprint do banco preservado.`)).catch(e=>{console.error(e);process.exitCode=1;});
