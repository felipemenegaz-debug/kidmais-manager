import { withTransaction } from '../../db/postgres';
import { lerPosicaoFinanceira, serializarFinanceiro } from '../repositories/alteracao-financeira.repository';

export async function consultarPainelFinanceiro(contratoId:string){return withTransaction(async tx=>{
 const p=await lerPosicaoFinanceira(tx,contratoId);
 const eventos=(await tx.query<{id:string;tipo:string;criado_em:string;resultado:Record<string,unknown>;identidade_snapshot:Record<string,unknown>;justificativa:string|null}>('SELECT id,tipo,criado_em::text,resultado,identidade_snapshot,justificativa FROM pagamento_eventos WHERE pagamento_id=$1 ORDER BY sequencia',[p.pagamento.id])).rows;
 const origens=(await tx.query<{id:string;recebimento_id:string;parcela_id:string;disponivel_centavos:string;valor_bruto:string;recebido_em:string;meio_pagamento:string}>(`SELECT a.id,a.recebimento_id,a.parcela_id,r.valor_bruto::text,r.recebido_em::text,r.meio_pagamento,(a.valor_alocado*100-coalesce((SELECT sum(e.valor)*100 FROM pagamento_estornos e WHERE e.recebimento_id=a.recebimento_id AND e.parcela_id=a.parcela_id AND e.status IN ('SOLICITADO','CONFIRMADO')),0)-coalesce((SELECT sum(da.valor_centavos) FROM pagamento_devolucao_alocacoes da JOIN pagamento_devolucoes d ON d.id=da.devolucao_id WHERE da.recebimento_alocacao_id=a.id AND d.estado IN ('PENDENTE','CONCLUIDA')),0))::bigint::text disponivel_centavos FROM pagamento_recebimento_alocacoes a JOIN pagamento_recebimentos r ON r.id=a.recebimento_id WHERE r.pagamento_id=$1 AND r.status='CONFIRMADO' ORDER BY r.recebido_em,a.id`,[p.pagamento.id])).rows;
 const provas=(await tx.query<{id:string;devolucao_id:string;nome_arquivo:string}>('SELECT c.id,c.devolucao_id,c.nome_arquivo FROM pagamento_devolucao_comprovantes c JOIN pagamento_devolucoes d ON d.id=c.devolucao_id WHERE d.pagamento_id=$1 ORDER BY c.criado_em',[p.pagamento.id])).rows;
 const timeline:Array<{id:string;tipo:string;instante:string|null;fonte:string;valorCentavos?:string;responsavel?:string;detalhe?:string|null}>=eventos.map(e=>({id:e.id,tipo:e.tipo,instante:e.criado_em,fonte:'EVENTO_015',responsavel:String(e.identidade_snapshot.nome??e.identidade_snapshot.processo??''),detalhe:e.justificativa}));
 for(const r of p.recebimentos)if(!eventos.some(e=>e.resultado.movimentoId===r.id&&e.tipo==='RECEBIMENTO_'+(r.status==='CONFIRMADO'?'CONFIRMADO':'REGISTRADO')))timeline.push({id:r.id,tipo:'RECEBIMENTO_'+r.status,instante:r.confirmado_em??r.recebido_em,fonte:'REGISTRO_FINANCEIRO_EXISTENTE'});
 for(const e of p.estornos)if(!eventos.some(ev=>ev.resultado.movimentoId===e.id&&ev.tipo==='ESTORNO_'+e.status))timeline.push({id:e.id,tipo:'ESTORNO_'+e.status,instante:e.confirmado_em,fonte:'REGISTRO_FINANCEIRO_EXISTENTE'});
 const entidades=[p.pagamento.id,...p.planos.map(x=>x.id),...p.parcelas.map(x=>x.id),...p.recebimentos.map(x=>x.id),...p.estornos.map(x=>x.id)];
 const auditoria=(await tx.query<{id:string;acao:string;entidade_id:string;criado_em:string;justificativa:string|null}>("SELECT id,acao,entidade_id,criado_em::text,justificativa FROM auditoria WHERE entidade_id=ANY($1::uuid[]) ORDER BY criado_em,id",[entidades])).rows;
 for(const a of auditoria){
  if(eventos.some(e=>e.tipo===a.acao&&e.resultado.movimentoId===a.entidade_id))continue;
  const origem=timeline.findIndex(t=>t.fonte==='REGISTRO_FINANCEIRO_EXISTENTE'&&t.id===a.entidade_id&&t.tipo===a.acao);if(origem>=0)timeline.splice(origem,1);
  timeline.push({id:a.id,tipo:a.acao,instante:a.criado_em,fonte:'AUDITORIA_EXISTENTE',detalhe:a.justificativa});
 }
 timeline.sort((a,b)=>(a.instante??'').localeCompare(b.instante??'')||a.id.localeCompare(b.id));
 const pendencias=p.pendencias.map(pend=>{const ts=p.tratamentos.filter(t=>t.pendencia_id===pend.id);return{...pend,situacao:p.ajustes.some(a=>a.versao_reconhecida_id===pend.versao_nova_id)?'RESOLVIDA':pend.versao_nova_id!==p.vigente.id?'SUPERADA':ts.some(t=>t.estado==='EM_TRATAMENTO')?'EM_TRATAMENTO':p.motivos.length?'PENDENTE':'SEM_IMPACTO',tentativas:ts};});
 return serializarFinanceiro({...p,pendencias,origens,provas,timeline});
});}
