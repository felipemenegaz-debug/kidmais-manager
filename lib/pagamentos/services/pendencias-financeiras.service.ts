import { randomUUID } from 'node:crypto';
import type { DbExecutor } from '../../db/contracts';
import type { ContratoVersaoRecord } from '../../contratos/repositories';
import { hashSnapshotContrato } from '../../contratos/services/snapshot-core';
import { lerPosicaoFinanceira } from '../repositories/alteracao-financeira.repository';
import { reaisCentavos } from './alteracao-financeira-core';

/** Chamado na promoção contratual, sob o lock de Fechamento/Contrato já adquirido. */
export async function detectarPendenciasFinanceiras(tx:DbExecutor,v:ContratoVersaoRecord,anterior:string|null){
 if(!anterior)return;
 if(!(await tx.query('SELECT p.id FROM pagamentos p JOIN contrato_versoes cv ON cv.id=p.contrato_versao_id WHERE cv.contrato_id=$1',[v.contratoId])).rows.length)return;
 const p=await lerPosicaoFinanceira(tx,v.contratoId);
 const comercial=(c:ContratoVersaoRecord['snapshot']['comercial'])=>({forma:c.condicaoPagamento?.forma??c.formaPagamentoPretendida??null,condicao:c.condicaoPagamento?.aprovada??null});
 const motivos:string[]=[];
 if(reaisCentavos(v.snapshot.comercial.valorFinalContrato)!==p.posicao.obrigacao)motivos.push('VALOR');
 if(hashSnapshotContrato(comercial(v.snapshot.comercial))!==hashSnapshotContrato(comercial(p.reconhecida.snapshot.comercial)))motivos.push('CONDICAO');
 if(v.snapshot.contratante.clienteId!==p.reconhecida.snapshot.contratante?.clienteId)motivos.push('CONTRATANTE');
 if(comercial(v.snapshot.comercial).forma==='PIX_PARCELADO'&&p.futuro.some(i=>BigInt(i.valorCentavos)>0n&&i.vencimento>v.snapshot.evento.data))motivos.push('CRONOGRAMA_DATA');
 if(motivos.length)await tx.query(`INSERT INTO contrato_pendencias_financeiras(contrato_id,versao_anterior_id,versao_nova_id,pagamento_id,motivo,diferencas) VALUES($1,$2,$3,$4,'Alteração contratual exige tratamento financeiro explícito',$5) ON CONFLICT(pagamento_id,versao_nova_id) DO NOTHING`,[v.contratoId,anterior,v.id,p.pagamento.id,{motivos,versaoFinanceiraReconhecidaId:p.reconhecida.id,obrigacaoReconhecidaCentavos:p.posicao.obrigacao.toString(),novaVersao:v.snapshot.comercial,clienteAnteriorId:p.reconhecida.snapshot.contratante?.clienteId,clienteNovoId:v.snapshot.contratante.clienteId}]);
 for(const pend of p.pendencias.filter(pend=>pend.versao_nova_id!==v.id&&!p.ajustes.some(a=>a.versao_reconhecida_id===pend.versao_nova_id))){
  if((await tx.query("SELECT id FROM pagamento_eventos WHERE pendencia_id=$1 AND tipo='PENDENCIA_SUPERADA'",[pend.id])).rows.length)continue;
  await tx.query('INSERT INTO pagamento_gestoes(pagamento_id,contrato_id) VALUES($1,$2) ON CONFLICT(pagamento_id) DO NOTHING',[p.pagamento.id,v.contratoId]);
  await tx.query("UPDATE pagamento_tratamentos SET estado='SUPERADA',encerrado_em=clock_timestamp(),motivo_encerramento='Versão contratual posterior entrou em vigor' WHERE pendencia_id=$1 AND estado='EM_TRATAMENTO'",[pend.id]);
  const seq=(await tx.query<{sequencia:string}>('UPDATE pagamento_gestoes SET sequencia=sequencia+1 WHERE pagamento_id=$1 RETURNING sequencia::text',[p.pagamento.id])).rows[0].sequencia;
  const pedido={pendenciaId:pend.id,versaoVigenteId:v.id};
  await tx.query(`INSERT INTO pagamento_eventos(pagamento_id,sequencia,pendencia_id,tipo,chave_idempotencia,pedido_hash,ator_tipo,identidade_snapshot,request_id,dados_antes,dados_depois,resultado) VALUES($1,$2,$3,'PENDENCIA_SUPERADA',$4,$5,'SISTEMA',$6,$7,$8,$9,$9)`,[p.pagamento.id,seq,pend.id,randomUUID(),hashSnapshotContrato(pedido),{processo:'PROMOCAO_CONTRATUAL'},randomUUID(),{versaoAnteriorId:pend.versao_nova_id},pedido]);
 }
}
