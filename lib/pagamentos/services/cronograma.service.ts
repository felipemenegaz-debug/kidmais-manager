import { randomUUID } from 'node:crypto';
import type { DbExecutor } from '../../db/contracts';
import { withTransaction } from '../../db/postgres';
import { lerPosicaoFinanceira, type PosicaoFinanceira } from '../repositories/alteracao-financeira.repository';
import { reaisCentavos, reaisSql, recusarFinanceiro } from './alteracao-financeira-core';
import type { PedidoResolucao, VersaoFinanceira, ContextoFinanceiro } from './alteracao-financeira.models';
import { bloquearFinanceiro, repetirEvento, registrarEventoFinanceiro, simularPosicao } from './alteracao-financeira.service';
export async function gravarCronograma(tx:DbExecutor,p:PosicaoFinanceira,input:PedidoResolucao,meta:{id:string;eventoId:string;ajusteId?:string;usuarioId:string;saldo:bigint;versao:VersaoFinanceira}){
 if(p.cronograma)await tx.query("UPDATE pagamento_cronogramas SET estado='SUBSTITUIDO',substituido_em=clock_timestamp() WHERE id=$1",[p.cronograma.id]);
 const novas=input.parcelas.filter(i=>!i.parcelaId);let planoId:string|null=null;
 // O plano é somente um recipiente para parcelas NOVAS, nunca a fonte consolidada.
 if(novas.length){
  planoId=randomUUID();
  await tx.query("UPDATE pagamento_planos SET status='SUBSTITUIDO',substituido_em=clock_timestamp(),motivo_substituicao=$2 WHERE pagamento_id=$1 AND status='ATIVO'",[p.pagamento.id,input.justificativa]);
  const forma=meta.versao.snapshot.comercial.condicaoPagamento?.forma??meta.versao.snapshot.comercial.formaPagamentoPretendida;
  await tx.query(`INSERT INTO pagamento_planos(id,pagamento_id,numero_versao,status,meio_pagamento,modalidade,quantidade_parcelas,observacoes,criado_por_usuario_id) VALUES($1,$2,$3,'ATIVO',$4,$5,$6,$7,$8)`,[planoId,p.pagamento.id,Math.max(0,...p.planos.map(p=>p.numero_versao))+1,forma==='CARTAO_CIELO'?'CARTAO':'PIX',novas.length===1?'AVISTA':'PARCELADO',novas.length,input.justificativa,meta.usuarioId]);
 }
 await tx.query(`INSERT INTO pagamento_cronogramas(id,pagamento_id,evento_id,ajuste_id,cronograma_anterior_id,plano_id,versao_referencia_id,estado,modo,saldo_inicial_centavos,data_festa_referencia) VALUES($1,$2,$3,$4,$5,$6,$7,'ATIVO',$8,$9,$10)`,[meta.id,p.pagamento.id,meta.eventoId,meta.ajusteId??null,p.cronograma?.id??null,planoId,meta.versao.id,input.modo,meta.saldo.toString(),meta.versao.snapshot.evento.data]);
 let numeroNova=0;
 for(const [i,proposta]of input.parcelas.entries()){
  const antiga=proposta.parcelaId?p.parcelas.find(i=>i.id===proposta.parcelaId?.toLowerCase()):null;
  const parcelaId=antiga?.id??randomUUID();
  if(!antiga)await tx.query('INSERT INTO pagamento_parcelas(id,plano_id,numero,valor_previsto,vencimento,confirma_reserva) VALUES($1,$2,$3,$4,$5,$6)',[parcelaId,planoId,++numeroNova,reaisSql(BigInt(proposta.valorCentavos)),proposta.vencimento,p.pagamento.reserva_status==='PENDENTE'&&!input.parcelas.some(x=>x.parcelaId&&p.parcelas.some(pp=>pp.id===x.parcelaId&&pp.confirma_reserva))&&numeroNova===1]);
  const anterior=antiga?p.itens.find(x=>x.parcela_id===antiga.id):null;
  await tx.query(`INSERT INTO pagamento_cronograma_itens(cronograma_id,parcela_id,item_anterior_id,ordem,origem,saldo_inicial_centavos,recebido_base_centavos,estornado_base_centavos,vencimento_referencia) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[meta.id,parcelaId,anterior?.id??null,i+1,antiga?'PRESERVADA':input.modo==='MANTER_E_COMPLEMENTAR'?'COMPLEMENTO':'REPROGRAMADA',proposta.valorCentavos,antiga?reaisCentavos(antiga.recebido).toString():'0',antiga?reaisCentavos(antiga.estornado).toString():'0',proposta.vencimento]);
 }
}
export async function reprogramarCronograma(contratoId:string,input:PedidoResolucao,chave:string,context:ContextoFinanceiro){return withTransaction(async tx=>{
 const s=await bloquearFinanceiro(tx,contratoId,context),p=await lerPosicaoFinanceira(tx,contratoId),pedido={acao:'reprogramar',...input};
 const retry=await repetirEvento(tx,p.pagamento.id,chave,pedido,s.usuario_id);if(retry)return retry;
 if(!p.ajustes.length)recusarFinanceiro('CRONOGRAMA_LEGADO','Use a substituição de plano existente antes da primeira regularização.');
 const sim=simularPosicao(p,input,true),id=randomUUID(),resultado={cronogramaId:id};
 const eventoId=await registrarEventoFinanceiro(tx,p,s,context,{tipo:'CRONOGRAMA_REPROGRAMADO',chave,pedido,justificativa:input.justificativa,resultado,depois:sim});
 await gravarCronograma(tx,p,input,{id,eventoId,usuarioId:s.usuario_id,saldo:sim.depois.saldo,versao:p.reconhecida});return{resultado,reutilizado:false};
});}
