import { randomUUID } from 'node:crypto';
import type { DbExecutor } from '../../db/contracts';
import { consultarSessao } from '../../autenticacao/service';
import { lerPosicaoFinanceira, type PosicaoFinanceira } from '../repositories/alteracao-financeira.repository';
import { registrarEventoFinanceiro, conferirPosicao, simularPosicao } from './alteracao-financeira.service';
import { gravarCronograma } from './cronograma.service';
import type { PedidoResolucao } from './alteracao-financeira.models';
import { reaisCentavos, recusarFinanceiro } from './alteracao-financeira-core';
import type { PagamentoServiceContext } from './models';

export async function posicaoDoPagamento(tx:DbExecutor,pagamentoId:string){
 const row=(await tx.query<{contrato_id:string}>('SELECT v.contrato_id FROM pagamentos p JOIN contrato_versoes v ON v.id=p.contrato_versao_id WHERE p.id=$1',[pagamentoId])).rows[0];
 if(!row)recusarFinanceiro('PAGAMENTO_NAO_ENCONTRADO','Pagamento não encontrado.',404);
 return lerPosicaoFinanceira(tx,row.contrato_id,true);
}
export async function possuiCronograma(tx:DbExecutor,pagamentoId:string){return (await tx.query('SELECT id FROM pagamento_cronogramas WHERE pagamento_id=$1 AND estado=\'ATIVO\'',[pagamentoId])).rows.length>0;}

export function validarCapacidadeConsolidada(p:PosicaoFinanceira,valor:number,alocacoes:Array<{parcelaId:string;valor:number}>){
 if(reaisCentavos(valor)>p.posicao.saldo)recusarFinanceiro('VALOR_EXCEDE_SALDO','O valor excede a obrigação financeiramente reconhecida. Regularize o adicional antes de recebê-lo.');
 if(!p.cronograma)return;
 for(const a of alocacoes){
  const item=p.futuro.find(i=>i.parcelaId===a.parcelaId.toLowerCase());
  if(!item)recusarFinanceiro('ALOCACAO_INVALIDA','A parcela não pertence ao cronograma consolidado vigente.');
  if(reaisCentavos(a.valor)>BigInt(item.valorCentavos))recusarFinanceiro('VALOR_EXCEDE_SALDO','A alocação excede o saldo do item consolidado.');
 }
}

/** A identidade operacional é conferida na mesma transação do fato. */
export async function eventoMovimento(tx:DbExecutor,p:PosicaoFinanceira,ctx:PagamentoServiceContext,tipo:'RECEBIMENTO_REGISTRADO'|'RECEBIMENTO_CONFIRMADO'|'ESTORNO_SOLICITADO'|'ESTORNO_CONFIRMADO',id:string,extra:Record<string,unknown>={}){
 const sessao=await consultarSessao(ctx.token??'',tx,true);
 if(sessao.usuario_id!==ctx.usuarioId)recusarFinanceiro('OPERACAO_NAO_AUTORIZADA','Sessão e responsável financeiro divergentes.',403);
 const depois=await lerPosicaoFinanceira(tx,p.contrato.id,true);
 const eventoId=await registrarEventoFinanceiro(tx,p,sessao,{token:ctx.token!,requestId:ctx.requestId??randomUUID(),ip:ctx.ip??null,userAgent:ctx.userAgent??null},{tipo,chave:randomUUID(),pedido:{tipo,id,...extra},resultado:{movimentoId:id,...extra},depois:depois.posicao});
 const recebimento=tipo.startsWith('RECEBIMENTO');
 // O contexto de origem nasce uma vez. A confirmação posterior tem seu próprio evento.
 await tx.query(`INSERT INTO pagamento_movimentos_contextos(pagamento_id,recebimento_id,estorno_id,evento_id,versao_financeira_id,pagador_cliente_id,identidade_economica_snapshot)
 VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,[p.pagamento.id,recebimento?id:null,recebimento?null:id,eventoId,p.reconhecida.id,p.reconhecida.snapshot.contratante?.clienteId??null,{contratante:p.reconhecida.snapshot.contratante??{},versao:p.reconhecida.numero_versao}]);
}

export async function consolidarCronogramaDoEstorno(tx:DbExecutor,antes:PosicaoFinanceira,ctx:PagamentoServiceContext,estornoId:string,input?:PedidoResolucao){
 if(!antes.cronograma){if(input)recusarFinanceiro('CRONOGRAMA_LEGADO','Reprogramação consolidada exige regularização anterior.');return;}
 const depois=await posicaoDoPagamento(tx,antes.pagamento.id);
 const programado=depois.futuro.reduce((sum,i)=>sum+BigInt(i.valorCentavos),0n);
 if(!input){if(programado!==depois.posicao.saldo)recusarFinanceiro('ESTORNO_EXIGE_REPROGRAMACAO','O estorno altera saldo fora do cronograma. Informe a reprogramação explícita para confirmar ambas as operações na mesma transação.');return;}
 conferirPosicao(antes,input.posicaoHash);
 const sim=simularPosicao({...depois,posicaoHash:antes.posicaoHash},input,true);
 const sessao=await consultarSessao(ctx.token??'',tx,true);
 if(sessao.usuario_id!==ctx.usuarioId)recusarFinanceiro('OPERACAO_NAO_AUTORIZADA','Sessão divergente.',403);
 const id=randomUUID(),eventoId=await registrarEventoFinanceiro(tx,antes,sessao,{token:ctx.token!,requestId:ctx.requestId??randomUUID(),ip:ctx.ip??null,userAgent:ctx.userAgent??null},{tipo:'CRONOGRAMA_REPROGRAMADO',chave:randomUUID(),pedido:{estornoId,...input},justificativa:input.justificativa,resultado:{cronogramaId:id,estornoId},depois:sim});
 await gravarCronograma(tx,depois,input,{id,eventoId,usuarioId:sessao.usuario_id,saldo:sim.depois.saldo,versao:depois.reconhecida});
}

export async function validarEstornoComDevolucoes(tx:DbExecutor,p:PosicaoFinanceira,recebimentoId:string,parcelaId:string,valor:number,referencia?:string|null,provedor?:string|null,confirmar=true){
 const devolvido=(await tx.query<{valor:string}>(`SELECT coalesce(sum(da.valor_centavos),0)::text valor FROM pagamento_devolucao_alocacoes da JOIN pagamento_devolucoes d ON d.id=da.devolucao_id JOIN pagamento_recebimento_alocacoes a ON a.id=da.recebimento_alocacao_id WHERE a.recebimento_id=$1 AND a.parcela_id=$2 AND d.estado IN ('PENDENTE','CONCLUIDA')`,[recebimentoId,parcelaId])).rows[0];
 if(referencia&&provedor&&(await tx.query('SELECT id FROM pagamento_devolucoes WHERE provedor_codigo=$1 AND referencia_externa=$2',[provedor,referencia])).rows.length)recusarFinanceiro('ESTORNO_INVALIDO','A saída já está registrada como devolução.');
 if(confirmar&&p.posicao.reservado>0n&&p.posicao.liquido-reaisCentavos(valor)-p.posicao.obrigacao<p.posicao.reservado)recusarFinanceiro('CREDITO_RESERVADO','O estorno comprometeria uma devolução pendente. Cancele a solicitação antes de reavaliar.');
 return BigInt(devolvido.valor);
}
