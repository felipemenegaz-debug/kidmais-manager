/* eslint-disable @typescript-eslint/no-require-imports */
const assert=require('node:assert/strict'),{randomUUID}=require('node:crypto'),{Client}=require('pg'),{setTimeout:pause}=require('node:timers/promises');
module.exports=async({c,admin,festa,payment,receber,nova,fresh,freeze,accept,op,ok})=>{
 const {db}=require('../lib/db/postgres.ts'),{installPool}=require('./pagamentos-test-support.cjs'),{lerPosicaoFinanceira}=require('../lib/pagamentos/repositories/alteracao-financeira.repository.ts');
 const s=require('../lib/pagamentos/services/alteracao-financeira.service.ts'),d=require('../lib/pagamentos/services/devolucao.service.ts'),ps=require('../lib/pagamentos/services/pagamento.service.ts');
 const ctx={token:admin.token,requestId:randomUUID(),ip:null,userAgent:'Fluxo financeiro completo 015'},pc={...ctx,usuarioId:admin.usuarioId,origem:'INTEGRACAO_015'};
 const f=await festa('2095-08-15'),pagamento=await payment(f),receipt=await receber(pagamento),original=pagamento.pagamento.valorTotalContratado;
 const docs=(await c.query('SELECT cd.id,cd.pdf_hash,encode(cd.conteudo_pdf,\'hex\') bytes FROM contrato_documentos cd JOIN contrato_versoes v ON v.id=cd.contrato_versao_id WHERE v.contrato_id=$1 ORDER BY cd.id',[f.cid])).rows;
 const v2=await nova(f);await op(v2,await fresh(v2,{comercial:{confirmarAprovacao:true,forma:'CARTAO_CIELO',baseNegociada:original-100,condicaoPix:null}}));await freeze(v2);await accept(v2);
 let p=await lerPosicaoFinanceira(db(),f.cid);assert.equal(p.posicao.credito,0n);assert.equal(p.valorVigente,p.posicao.obrigacao-10000n);
 const aberto=await s.iniciarTratamento(f.cid,p.pendencias.at(-1).id,p.posicaoHash,randomUUID(),ctx);p=await lerPosicaoFinanceira(db(),f.cid);
 await s.resolverAlteracao(f.cid,aberto.resultado.tratamentoId,{posicaoHash:p.posicaoHash,modo:'SEM_SALDO',parcelas:[],credito:'MANTER',decisaoContratante:'NAO_SE_APLICA',justificativa:'Redução contratual assinada e crédito mantido'},randomUUID(),ctx);
 p=await lerPosicaoFinanceira(db(),f.cid);assert.equal(p.posicao.credito,10000n);assert.equal(p.cronograma.plano_id,null);
 ok('015: Fechamento → Contrato V1/Pagamento → V2 reduzida, assinatura Kidmais + OTP → regularização explícita → crédito; sem plano artificial');
 const pool=globalThis.__kidmaisPgPool,a=new Client({connectionString:process.env.DATABASE_URL}),b=new Client({connectionString:process.env.DATABASE_URL});await a.connect();await b.connect();
 async function race(first,second,{rollback=false,falha=false}={}){
  let pending;await a.query('BEGIN');await b.query('BEGIN');await b.query("SET LOCAL lock_timeout='8s'");
  try{installPool(a);const one=await first();await a.query('SET CONSTRAINTS ALL IMMEDIATE');installPool(b);pending=second(one).then(value=>({value}),error=>({error}));const end=Date.now()+6000;let blocked=false;while(Date.now()<end){if((await c.query('SELECT pg_blocking_pids($1) pids',[b.processID])).rows[0].pids.includes(a.processID)){blocked=true;break;}await pause(15);}assert(blocked,'Espera física no PostgreSQL obrigatória');await a.query(rollback?'ROLLBACK':'COMMIT');const two=await pending;pending=null;if(falha){assert(two.error,'Segundo comando deve recusar');await b.query('ROLLBACK');}else{if(two.error)throw two.error;await b.query('SET CONSTRAINTS ALL IMMEDIATE');await b.query('COMMIT');}return{one,two};}
  finally{await a.query('ROLLBACK');if(pending)await pending;await b.query('ROLLBACK');globalThis.__kidmaisPgPool=pool;}
 }
 const pedido=pos=>({posicaoHash:pos.posicaoHash,valorCentavos:'10000',beneficiario:{nome:'Pagador do teste de fluxo completo'},motivo:'Devolução de crédito contratual',origens:[{alocacaoId:receipt.alocacoes[0].id,valorCentavos:'10000'}]});
 try{
  let body=pedido(p),key=randomUUID();const r=await race(()=>d.solicitarDevolucao(f.cid,body,key,ctx),()=>d.solicitarDevolucao(f.cid,body,key,ctx));assert.equal(r.two.value.reutilizado,true);ok('015 concorrência: mesma solicitação, duas conexões, um fato e replay idempotente');
  await d.cancelarDevolucao(f.cid,r.one.resultado.devolucaoId,'Liberar para próxima disputa',randomUUID(),ctx);p=await lerPosicaoFinanceira(db(),f.cid);body=pedido(p);
  const r2=await race(()=>d.solicitarDevolucao(f.cid,body,randomUUID(),ctx),()=>d.solicitarDevolucao(f.cid,body,randomUUID(),ctx),{falha:true});ok('015 concorrência: duas reservas disputam o mesmo crédito, apenas uma persiste');
  await d.cancelarDevolucao(f.cid,r2.one.resultado.devolucaoId,'Liberar crédito para estorno concorrente',randomUUID(),ctx);p=await lerPosicaoFinanceira(db(),f.cid);body=pedido(p);
  const estornar=()=>ps.registrarEstornoPagamento({pagamentoId:p.pagamento.id,recebimentoId:receipt.recebimento.id,parcelaId:receipt.alocacoes[0].parcelaId,valor:1,motivo:'Concorrência com reserva',chaveIdempotencia:randomUUID()},pc);
  const r3=await race(()=>d.solicitarDevolucao(f.cid,body,randomUUID(),ctx),estornar,{falha:true});assert.equal(r3.two.error.code,'CREDITO_RESERVADO');ok('015 concorrência: reserva vencedora impede estorno que consumiria crédito reservado');
  await d.cancelarDevolucao(f.cid,r3.one.resultado.devolucaoId,'Preparar confirmação final',randomUUID(),ctx);p=await lerPosicaoFinanceira(db(),f.cid);body=pedido(p);
  await race(()=>d.solicitarDevolucao(f.cid,body,randomUUID(),ctx),estornar,{rollback:true});ok('015 concorrência: rollback da reserva libera estorno, sem reserva fantasma');
  p=await lerPosicaoFinanceira(db(),f.cid);const novo={...pedido(p),valorCentavos:'5000',origens:[{alocacaoId:receipt.alocacoes[0].id,valorCentavos:'5000'}]},sol=await d.solicitarDevolucao(f.cid,novo,randomUUID(),ctx);
  p=await lerPosicaoFinanceira(db(),f.cid);const exec={posicaoHash:p.posicaoHash,devolvidoEm:new Date().toISOString(),meio:'PIX',observacao:'Saída sintética para validação concorrente',justificativaSemComprovante:'Clone de testes; não ocorreu operação bancária real'};key=randomUUID();
  const done=await race(()=>d.concluirDevolucao(f.cid,sol.resultado.devolucaoId,exec,key,ctx),()=>d.concluirDevolucao(f.cid,sol.resultado.devolucaoId,exec,key,ctx));assert.equal(done.two.value.reutilizado,true);p=await lerPosicaoFinanceira(db(),f.cid);assert.equal(p.posicao.devolvido,5000n);ok('015 concorrência: duas confirmações de devolução geram uma única saída');
  const v3=await nova({...f,vid:v2});await op(v3,await fresh(v3,{comercial:{confirmarAprovacao:true,forma:'CARTAO_CIELO',baseNegociada:original-50,condicaoPix:null}}));await freeze(v3);await accept(v3);
  p=await lerPosicaoFinanceira(db(),f.cid);let tentativa=await s.iniciarTratamento(f.cid,p.pendencias.at(-1).id,p.posicaoHash,randomUUID(),ctx);p=await lerPosicaoFinanceira(db(),f.cid);
  let resolucao={posicaoHash:p.posicaoHash,modo:'REPROGRAMAR',parcelas:[{valorCentavos:'100',vencimento:p.vigente.snapshot.evento.data}],credito:'APROVEITAR',decisaoContratante:'NAO_SE_APLICA',justificativa:'Aumento após devolução parcial e aproveitamento do crédito remanescente'};
  const resolver=()=>s.resolverAlteracao(f.cid,tentativa.resultado.tratamentoId,resolucao,randomUUID(),ctx);
  await race(resolver,resolver,{falha:true});p=await lerPosicaoFinanceira(db(),f.cid);assert.equal(p.ajustes.length,2);assert.equal(p.posicao.saldo,100n);ok('015 concorrência: duas resoluções com chaves distintas reconhecem o adicional uma única vez');
  const v4=await nova({...f,vid:v3});await op(v4,await fresh(v4,{comercial:{confirmarAprovacao:true,forma:'CARTAO_CIELO',baseNegociada:original-40,condicaoPix:null}}));await freeze(v4);await accept(v4);
  p=await lerPosicaoFinanceira(db(),f.cid);tentativa=await s.iniciarTratamento(f.cid,p.pendencias.at(-1).id,p.posicaoHash,randomUUID(),ctx);p=await lerPosicaoFinanceira(db(),f.cid);resolucao={...resolucao,posicaoHash:p.posicaoHash,credito:'NAO_SE_APLICA',parcelas:[{valorCentavos:'1100',vencimento:p.vigente.snapshot.evento.data}]};
  await race(async()=>{const result=await resolver();return(await a.query('SELECT parcela_id FROM pagamento_cronograma_itens WHERE cronograma_id=$1',[result.resultado.cronogramaId])).rows[0].parcela_id;},parcelaId=>ps.registrarRecebimentoPagamento({pagamentoId:p.pagamento.id,meioPagamento:'PIX',valorBruto:11,chaveIdempotencia:randomUUID(),alocacoes:[{parcelaId,valor:11}]},pc));
  p=await lerPosicaoFinanceira(db(),f.cid);assert.equal(p.posicao.saldo,0n);ok('015 concorrência: recebimento aguarda resolução e utiliza somente o cronograma reconhecido após commit');
  const v5=await nova({...f,vid:v4});await op(v5,await fresh(v5,{comercial:{confirmarAprovacao:true,forma:'CARTAO_CIELO',baseNegociada:original-60,condicaoPix:null}}));await freeze(v5);await accept(v5);
  p=await lerPosicaoFinanceira(db(),f.cid);tentativa=await s.iniciarTratamento(f.cid,p.pendencias.at(-1).id,p.posicaoHash,randomUUID(),ctx);p=await lerPosicaoFinanceira(db(),f.cid);resolucao={...resolucao,posicaoHash:p.posicaoHash,modo:'SEM_SALDO',credito:'MANTER',parcelas:[]};await resolver();
  p=await lerPosicaoFinanceira(db(),f.cid);assert.equal(p.posicao.credito,2000n);ok('015: nova redução após quitação preserva toda a cadeia e deixa crédito para validação visual');
  const atual=(await c.query('SELECT cd.id,cd.pdf_hash,encode(cd.conteudo_pdf,\'hex\') bytes FROM contrato_documentos cd JOIN contrato_versoes v ON v.id=cd.contrato_versao_id WHERE v.contrato_id=$1 ORDER BY cd.id',[f.cid])).rows;for(const doc of docs)assert.deepEqual(atual.find(x=>x.id===doc.id),doc);
  assert.equal((await c.query('SELECT valor_total_contratado FROM pagamentos WHERE id=$1',[p.pagamento.id])).rows[0].valor_total_contratado,original.toFixed(2));ok('015: PDFs/BYTEA e obrigação original do ciclo completo preservados byte a byte');
 }finally{await a.end();await b.end();globalThis.__kidmaisPgPool=pool;}
};
