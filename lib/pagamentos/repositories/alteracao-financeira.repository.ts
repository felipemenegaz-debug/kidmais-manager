import { situacaoCobranca } from '../services/cancelamento-core';
import type { DbExecutor } from '../../db/contracts';
import { hashSnapshotContrato } from '../../contratos/services/snapshot-core';
import { posicaoEconomica, reaisCentavos, recusarFinanceiro } from '../services/alteracao-financeira-core';
import type { VersaoFinanceira, AjusteFinanceiro, CronogramaFinanceiro, ItemCronograma, MovimentoFinanceiro, EstornoFinanceiro, DevolucaoFinanceira, ParcelaFinanceira, PendenciaFinanceira, TratamentoFinanceiro } from '../services/alteracao-financeira.models';

export async function lerPosicaoFinanceira(tx: DbExecutor, contratoId: string, movimentoLegado = false) {
  const contrato = (await tx.query<{id:string;fechamento_id:string;versao_atual:number;status:string}>('SELECT id,fechamento_id,versao_atual,status FROM contratos WHERE id=$1',[contratoId])).rows[0];
  if (!contrato) recusarFinanceiro('RECURSO_NAO_ENCONTRADO','Contrato não encontrado.',404);
  const pagamento = (await tx.query<{id:string;contrato_versao_id:string;valor_total_contratado:string;status:string;reserva_status:string;quitado_em:string|null}>(`SELECT p.id,p.contrato_versao_id,p.valor_total_contratado::text,p.status,p.reserva_status,p.quitado_em::text FROM pagamentos p JOIN contrato_versoes v ON v.id=p.contrato_versao_id WHERE v.contrato_id=$1`,[contratoId])).rows;
  if (pagamento.length !== 1) recusarFinanceiro('OBRIGACAO_NAO_DISPONIVEL','É necessária exatamente uma obrigação original. Crie Pagamento pelo fluxo existente quando ainda não houver obrigação.');
  const p=pagamento[0];
  const versoes=(await tx.query<VersaoFinanceira>(`SELECT v.id,v.numero_versao,v.status,v.snapshot,v.snapshot_hash,e.estado FROM contrato_versoes v LEFT JOIN contrato_edicoes e ON e.contrato_versao_id=v.id WHERE v.contrato_id=$1 ORDER BY v.numero_versao`,[contratoId])).rows;
  const fluxo=(await tx.query<{versao_vigente_id:string|null;versao_em_preparacao_id:string|null}>('SELECT versao_vigente_id,versao_em_preparacao_id FROM contrato_fluxos WHERE contrato_id=$1',[contratoId])).rows[0];
  const original=versoes.find(v=>v.id===p.contrato_versao_id);
  const vigente=versoes.find(v=>v.id===fluxo?.versao_vigente_id)??versoes.find(v=>v.numero_versao===contrato.versao_atual && v.status==='ASSINADA')??(!fluxo&&movimentoLegado?original:undefined);
  if(!vigente||!original)recusarFinanceiro('VERSAO_NAO_VIGENTE','Versão assinada não encontrada.');
  if(hashSnapshotContrato(vigente.snapshot)!==vigente.snapshot_hash||hashSnapshotContrato(original.snapshot)!==original.snapshot_hash)recusarFinanceiro('SNAPSHOT_DIVERGENTE','Integridade contratual divergente.');
  const ajustes=(await tx.query<AjusteFinanceiro>(`SELECT a.id,a.versao_reconhecida_id,a.obrigacao_depois_centavos::text,a.delta_centavos::text,a.evento_id FROM pagamento_ajustes_contratuais a JOIN pagamento_eventos e ON e.id=a.evento_id WHERE a.pagamento_id=$1 ORDER BY e.sequencia`,[p.id])).rows;
  const reconhecida=versoes.find(v=>v.id===ajustes.at(-1)?.versao_reconhecida_id)??original;
  const recebimentos=(await tx.query<MovimentoFinanceiro>('SELECT id,status,valor_bruto::text,recebido_em::text,confirmado_em::text FROM pagamento_recebimentos WHERE pagamento_id=$1 ORDER BY id',[p.id])).rows;
  const estornos=(await tx.query<EstornoFinanceiro>('SELECT e.id,e.recebimento_id,e.parcela_id,e.status,e.valor::text,e.confirmado_em::text FROM pagamento_estornos e JOIN pagamento_recebimentos r ON r.id=e.recebimento_id WHERE r.pagamento_id=$1 ORDER BY e.id',[p.id])).rows;
  const devolucoes=(await tx.query<DevolucaoFinanceira>('SELECT id,reserva_id,estado,valor_centavos::text,devolvido_em::text,beneficiario_snapshot FROM pagamento_devolucoes WHERE pagamento_id=$1 ORDER BY id',[p.id])).rows;
  const reservas=(await tx.query<{id:string;estado:string;valor_centavos:string}>('SELECT id,estado,valor_centavos::text FROM pagamento_credito_reservas WHERE pagamento_id=$1 ORDER BY id',[p.id])).rows;
  const parcelas=(await tx.query<ParcelaFinanceira>(`SELECT pp.id,pp.plano_id,pp.numero,pp.valor_previsto::text,pp.vencimento::text,pp.status,pp.confirma_reserva,
  coalesce((SELECT sum(a.valor_alocado) FROM pagamento_recebimento_alocacoes a JOIN pagamento_recebimentos r ON r.id=a.recebimento_id WHERE a.parcela_id=pp.id AND r.status='CONFIRMADO'),0)::text AS recebido,
  coalesce((SELECT sum(e.valor) FROM pagamento_estornos e WHERE e.parcela_id=pp.id AND e.status='CONFIRMADO'),0)::text AS estornado
  FROM pagamento_parcelas pp JOIN pagamento_planos pl ON pl.id=pp.plano_id WHERE pl.pagamento_id=$1 ORDER BY pp.id`,[p.id])).rows;
  const planos=(await tx.query<{id:string;status:string;numero_versao:number}>('SELECT id,status,numero_versao FROM pagamento_planos WHERE pagamento_id=$1 ORDER BY numero_versao',[p.id])).rows;
  const cronograma=(await tx.query<CronogramaFinanceiro>('SELECT id,plano_id,versao_referencia_id,saldo_inicial_centavos::text,estado FROM pagamento_cronogramas WHERE pagamento_id=$1 AND estado=\'ATIVO\'',[p.id])).rows[0]??null;
  const itens=cronograma?(await tx.query<ItemCronograma>('SELECT id,parcela_id,saldo_inicial_centavos::text,recebido_base_centavos::text,estornado_base_centavos::text,vencimento_referencia::text FROM pagamento_cronograma_itens WHERE cronograma_id=$1 ORDER BY ordem',[cronograma.id])).rows:[];
  const encerrada=contrato.status==='CANCELADO'||p.status==='CANCELADO';
  const futuro=encerrada?[]:cronograma?itens.map(i=>{const parcela=parcelas.find(p=>p.id===i.parcela_id)!;const saldo=BigInt(i.saldo_inicial_centavos)-(reaisCentavos(parcela.recebido)-reaisCentavos(parcela.estornado)-BigInt(i.recebido_base_centavos)+BigInt(i.estornado_base_centavos));return{parcelaId:parcela.id,itemId:i.id,valorCentavos:(saldo>0n?saldo:0n).toString(),vencimento:i.vencimento_referencia};}):parcelas.filter(pp=>planos.some(pl=>pl.id===pp.plano_id&&pl.status==='ATIVO')&&pp.status!=='CANCELADA').map(pp=>{const saldo=reaisCentavos(pp.valor_previsto)-reaisCentavos(pp.recebido)+reaisCentavos(pp.estornado);return{parcelaId:pp.id,itemId:null,valorCentavos:(saldo>0n?saldo:0n).toString(),vencimento:pp.vencimento};});
  const posicao=posicaoEconomica(reaisCentavos(p.valor_total_contratado),ajustes.reduce((a,j)=>a+BigInt(j.delta_centavos),0n),recebimentos.filter(r=>r.status==='CONFIRMADO').reduce((a,r)=>a+reaisCentavos(r.valor_bruto),0n),estornos.filter(e=>e.status==='CONFIRMADO').reduce((a,e)=>a+reaisCentavos(e.valor),0n),devolucoes.filter(d=>d.estado==='CONCLUIDA').reduce((a,d)=>a+BigInt(d.valor_centavos),0n),reservas.filter(r=>r.estado==='ATIVA').reduce((a,r)=>a+BigInt(r.valor_centavos),0n));
  const valorVigente=reaisCentavos(vigente.snapshot.comercial.valorFinalContrato);
  const comercial=(v:VersaoFinanceira)=>({forma:v.snapshot.comercial.condicaoPagamento?.forma??v.snapshot.comercial.formaPagamentoPretendida??null,condicao:v.snapshot.comercial.condicaoPagamento?.aprovada??null});
  const forma=comercial(vigente).forma;
  const motivos:string[]=[];
  if(valorVigente!==posicao.obrigacao)motivos.push('VALOR');
  if(hashSnapshotContrato(comercial(vigente))!==hashSnapshotContrato(comercial(reconhecida)))motivos.push('CONDICAO');
  if(vigente.snapshot.contratante?.clienteId!==reconhecida.snapshot.contratante?.clienteId)motivos.push('CONTRATANTE');
  if(forma==='PIX_PARCELADO'&&futuro.some(i=>BigInt(i.valorCentavos)>0n&&i.vencimento>vigente.snapshot.evento.data))motivos.push('CRONOGRAMA_DATA');
  const pendencias=(await tx.query<PendenciaFinanceira>('SELECT id,versao_anterior_id,versao_nova_id,motivo,criado_em::text FROM contrato_pendencias_financeiras WHERE pagamento_id=$1 ORDER BY criado_em,id',[p.id])).rows;
  const tratamentos=(await tx.query<TratamentoFinanceiro>('SELECT id,pendencia_id,pagamento_id,estado,tentativa,iniciado_por_usuario_id FROM pagamento_tratamentos WHERE pagamento_id=$1 ORDER BY tentativa',[p.id])).rows;
  const gestao=(await tx.query<{sequencia:string}>('SELECT sequencia::text FROM pagamento_gestoes WHERE pagamento_id=$1',[p.id])).rows[0];
  const cobranca=situacaoCobranca(contrato.status,p.status,recebimentos.length,posicao.saldo);
  const base={contratoStatus:contrato.status,pagamento:p,versoes,ajustes,recebimentos,estornos,devolucoes,reservas,parcelas,planos,cronograma,itens,sequencia:gestao?.sequencia??'0',vigente:vigente.id};
  return{cobranca,contrato,pagamento:p,original,vigente,reconhecida,ajustes,recebimentos,estornos,devolucoes,reservas,parcelas,planos,cronograma,itens,futuro,posicao,valorVigente,forma,motivos,pendencias,tratamentos,posicaoHash:hashSnapshotContrato(base)};
}
export type PosicaoFinanceira = Awaited<ReturnType<typeof lerPosicaoFinanceira>>;
export function serializarFinanceiro<T>(v:T):unknown{return JSON.parse(JSON.stringify(v,(_,x)=>typeof x==='bigint'?x.toString():x));}
