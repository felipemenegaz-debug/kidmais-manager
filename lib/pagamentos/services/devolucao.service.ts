import { randomUUID,createHash } from 'node:crypto';
import { withTransaction } from '../../db/postgres';
import { lerPosicaoFinanceira } from '../repositories/alteracao-financeira.repository';
import { bloquearFinanceiro,conferirPosicao,registrarEventoFinanceiro,repetirEvento } from './alteracao-financeira.service';
import { centavosInteiros,recusarFinanceiro } from './alteracao-financeira-core';
import type { ContextoFinanceiro } from './alteracao-financeira.models';
export type PedidoDevolucao={posicaoHash:string;valorCentavos:string;beneficiarioClienteId?:string;beneficiario:{nome:string;documento?:string};motivo:string;origens:Array<{alocacaoId:string;valorCentavos:string}>};
export async function solicitarDevolucao(contratoId:string,input:PedidoDevolucao,chave:string,context:ContextoFinanceiro){return withTransaction(async tx=>{
 const s=await bloquearFinanceiro(tx,contratoId,context),p=await lerPosicaoFinanceira(tx,contratoId),pedido={acao:'solicitar_devolucao',...input};
 const retry=await repetirEvento(tx,p.pagamento.id,chave,pedido,s.usuario_id);if(retry)return retry;
 conferirPosicao(p,input.posicaoHash);const valor=centavosInteiros(input.valorCentavos);
 if(valor>p.posicao.disponivel)recusarFinanceiro('CREDITO_INDISPONIVEL','Valor superior ao crédito disponível.');
 if(!input.beneficiario.nome.trim()||!input.motivo.trim())recusarFinanceiro('DADOS_INVALIDOS','Informe beneficiário e motivo.',400);
 if(input.origens.reduce((sum,o)=>sum+centavosInteiros(o.valorCentavos),0n)!==valor||new Set(input.origens.map(o=>o.alocacaoId.toLowerCase())).size!==input.origens.length)recusarFinanceiro('ORIGEM_FINANCEIRA_COMPROMETIDA','As origens devem somar exatamente o valor sem repetição.');
 for(const o of input.origens){
  const row=(await tx.query<{disponivel:string}>(`SELECT (a.valor_alocado*100 - coalesce((SELECT sum(valor)*100 FROM pagamento_estornos WHERE recebimento_id=a.recebimento_id AND parcela_id=a.parcela_id AND status IN ('SOLICITADO','CONFIRMADO')),0) - coalesce((SELECT sum(da.valor_centavos) FROM pagamento_devolucao_alocacoes da JOIN pagamento_devolucoes d ON d.id=da.devolucao_id WHERE da.recebimento_alocacao_id=a.id AND d.estado IN ('PENDENTE','CONCLUIDA')),0))::bigint::text disponivel FROM pagamento_recebimento_alocacoes a JOIN pagamento_recebimentos r ON r.id=a.recebimento_id WHERE a.id=$1 AND r.pagamento_id=$2 AND r.status='CONFIRMADO'`,[o.alocacaoId,p.pagamento.id])).rows[0];
  if(!row||centavosInteiros(o.valorCentavos)>BigInt(row.disponivel))recusarFinanceiro('ORIGEM_FINANCEIRA_COMPROMETIDA','Origem insuficiente para devolução.');
 }
 const id=randomUUID(),reservaId=randomUUID(),resultado={devolucaoId:id,estado:'PENDENTE',reservaId};
 const eventoId=await registrarEventoFinanceiro(tx,p,s,context,{tipo:'DEVOLUCAO_SOLICITADA',chave,pedido,justificativa:input.motivo,resultado,depois:{creditoReservadoCentavos:(p.posicao.reservado+valor).toString()}});
 await tx.query("INSERT INTO pagamento_credito_reservas(id,pagamento_id,evento_criacao_id,valor_centavos,estado) VALUES($1,$2,$3,$4,'ATIVA')",[reservaId,p.pagamento.id,eventoId,input.valorCentavos]);
 await tx.query("INSERT INTO pagamento_devolucoes(id,pagamento_id,reserva_id,evento_solicitacao_id,estado,valor_centavos,beneficiario_cliente_id,beneficiario_snapshot,motivo) VALUES($1,$2,$3,$4,'PENDENTE',$5,$6,$7,$8)",[id,p.pagamento.id,reservaId,eventoId,input.valorCentavos,input.beneficiarioClienteId??null,input.beneficiario,input.motivo]);
 for(const o of input.origens)await tx.query('INSERT INTO pagamento_devolucao_alocacoes(devolucao_id,recebimento_alocacao_id,valor_centavos) VALUES($1,$2,$3)',[id,o.alocacaoId,o.valorCentavos]);
 return{resultado,reutilizado:false};
});}
export type ExecucaoDevolucao={posicaoHash:string;devolvidoEm:string;meio:'PIX'|'CARTAO'|'TRANSFERENCIA'|'DINHEIRO'|'OUTRO';provedorCodigo?:string;referenciaExterna?:string;observacao:string;justificativaSemComprovante?:string};
export async function concluirDevolucao(contratoId:string,id:string,input:ExecucaoDevolucao,chave:string,context:ContextoFinanceiro){return withTransaction(async tx=>{
 const s=await bloquearFinanceiro(tx,contratoId,context);
 if(s.papel!=='REPRESENTANTE_AUTORIZADO')recusarFinanceiro('OPERACAO_NAO_AUTORIZADA','Somente REPRESENTANTE_AUTORIZADO pode confirmar a saída financeira.',403);
 const p=await lerPosicaoFinanceira(tx,contratoId),pedido={acao:'concluir_devolucao',id,...input};
 const retry=await repetirEvento(tx,p.pagamento.id,chave,pedido,s.usuario_id);if(retry)return retry;
 conferirPosicao(p,input.posicaoHash);
 const d=p.devolucoes.find(d=>d.id===id);if(!d||d.estado!=='PENDENTE')recusarFinanceiro('DEVOLUCAO_INDISPONIVEL','Devolução não está pendente.');
 const data=new Date(input.devolvidoEm);if(Number.isNaN(data.getTime())||data.getTime()>Date.now()||!input.observacao.trim())recusarFinanceiro('DADOS_INVALIDOS','Informe data real não futura e observação.',400);
 const evidencia=(await tx.query('SELECT id FROM pagamento_devolucao_comprovantes WHERE devolucao_id=$1',[id])).rows.length>0;
 if(!evidencia&&!input.justificativaSemComprovante?.trim())recusarFinanceiro('EVIDENCIA_OBRIGATORIA','Anexe comprovante ou justifique explicitamente sua ausência.',422);
 if(input.referenciaExterna&&!input.provedorCodigo)recusarFinanceiro('DADOS_INVALIDOS','Referência exige provedor.',400);
 const resultado={devolucaoId:id,estado:'CONCLUIDA'};
 const eventoId=await registrarEventoFinanceiro(tx,p,s,context,{tipo:'DEVOLUCAO_CONCLUIDA',chave,pedido,justificativa:input.observacao,resultado,depois:{devolvidoCentavos:(p.posicao.devolvido+BigInt(d.valor_centavos)).toString()}});
 await tx.query("UPDATE pagamento_devolucoes SET estado='CONCLUIDA',evento_conclusao_id=$2,devolvido_em=$3,meio_devolucao=$4,provedor_codigo=$5,referencia_externa=$6,observacao_execucao=$7,justificativa_sem_comprovante=$8 WHERE id=$1",[id,eventoId,data.toISOString(),input.meio,input.provedorCodigo??null,input.referenciaExterna??null,input.observacao,input.justificativaSemComprovante??null]);
 await tx.query("UPDATE pagamento_credito_reservas SET estado='CONSUMIDA',evento_encerramento_id=$2,encerrado_em=clock_timestamp() WHERE id=$1",[d.reserva_id,eventoId]);return{resultado,reutilizado:false};
});}
export async function cancelarDevolucao(contratoId:string,id:string,motivo:string,chave:string,context:ContextoFinanceiro){return withTransaction(async tx=>{
 const s=await bloquearFinanceiro(tx,contratoId,context),p=await lerPosicaoFinanceira(tx,contratoId),pedido={acao:'cancelar_devolucao',id,motivo};
 const retry=await repetirEvento(tx,p.pagamento.id,chave,pedido,s.usuario_id);if(retry)return retry;
 const d=p.devolucoes.find(d=>d.id===id);if(!d||d.estado!=='PENDENTE')recusarFinanceiro('DEVOLUCAO_INDISPONIVEL','Devolução não está pendente.');
 if(!motivo.trim())recusarFinanceiro('DADOS_INVALIDOS','Informe o motivo.',400);
 const resultado={devolucaoId:id,estado:'CANCELADA'};
 const eventoId=await registrarEventoFinanceiro(tx,p,s,context,{tipo:'DEVOLUCAO_CANCELADA',chave,pedido,justificativa:motivo,resultado});
 await tx.query("UPDATE pagamento_devolucoes SET estado='CANCELADA',evento_cancelamento_id=$2 WHERE id=$1",[id,eventoId]);
 await tx.query("UPDATE pagamento_credito_reservas SET estado='LIBERADA',evento_encerramento_id=$2,encerrado_em=clock_timestamp() WHERE id=$1",[d.reserva_id,eventoId]);return{resultado,reutilizado:false};
});}
export async function anexarComprovanteDevolucao(contratoId:string,id:string,nome:string,mime:string,conteudo:Buffer,chave:string,context:ContextoFinanceiro){return withTransaction(async tx=>{
 const s=await bloquearFinanceiro(tx,contratoId,context),p=await lerPosicaoFinanceira(tx,contratoId),hash=createHash('sha256').update(conteudo).digest('hex'),pedido={acao:'comprovante_devolucao',id,nome,mime,hash};
 const retry=await repetirEvento(tx,p.pagamento.id,chave,pedido,s.usuario_id);if(retry)return retry;
 const d=p.devolucoes.find(d=>d.id===id);if(!d||d.estado!=='PENDENTE')recusarFinanceiro('DEVOLUCAO_INDISPONIVEL','Anexe a evidência antes da conclusão.');
 const valido=(mime==='application/pdf'&&conteudo.subarray(0,5).toString()==='%PDF-')||(mime==='image/png'&&conteudo.subarray(0,8).toString('hex')==='89504e470d0a1a0a')||(mime==='image/jpeg'&&conteudo.subarray(0,3).toString('hex')==='ffd8ff');
 if(!valido||!nome.trim()||nome.length>255||conteudo.length===0||conteudo.length>10485760)recusarFinanceiro('COMPROVANTE_INVALIDO','Use PDF, JPEG ou PNG de até 10 MiB.',400);
 const comprovanteId=randomUUID(),resultado={comprovanteId};
 const eventoId=await registrarEventoFinanceiro(tx,p,s,context,{tipo:'COMPROVANTE_DEVOLUCAO_ANEXADO',chave,pedido,resultado});
 await tx.query('INSERT INTO pagamento_devolucao_comprovantes(id,devolucao_id,evento_id,nome_arquivo,mime_type,tamanho_bytes,sha256,conteudo) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[comprovanteId,id,eventoId,nome,mime,conteudo.length,hash,conteudo]);return{resultado,reutilizado:false};
});}
