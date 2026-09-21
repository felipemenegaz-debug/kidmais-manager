import { randomUUID } from 'node:crypto';
import type { DbExecutor } from '../../db/contracts';
import { withTransaction } from '../../db/postgres';
import { consultarSessao, type SessaoAdmin } from '../../autenticacao/service';
import { hashSnapshotContrato } from '../../contratos/services/snapshot-core';
import { lerPosicaoFinanceira, serializarFinanceiro, type PosicaoFinanceira } from '../repositories/alteracao-financeira.repository';
import { centavosInteiros, posicaoEconomica, reaisCentavos, recusarFinanceiro, validarCronogramaConsolidado } from './alteracao-financeira-core';
import type { ContextoFinanceiro, PedidoResolucao } from './alteracao-financeira.models';
import { gravarCronograma } from './cronograma.service';

export async function consultarFinanceiro(contratoId:string){return withTransaction(async tx=>serializarFinanceiro(await lerPosicaoFinanceira(tx,contratoId)));}
export async function bloquearFinanceiro(tx:DbExecutor,contratoId:string,context:ContextoFinanceiro){
  const c=(await tx.query<{fechamento_id:string}>('SELECT fechamento_id FROM contratos WHERE id=$1',[contratoId])).rows[0];
  if(!c)recusarFinanceiro('RECURSO_NAO_ENCONTRADO','Contrato não encontrado.',404);
  await tx.query('SELECT id FROM fechamentos WHERE id=$1 FOR UPDATE',[c.fechamento_id]);
  await tx.query('SELECT id FROM contratos WHERE id=$1 FOR UPDATE',[contratoId]);
  await tx.query('SELECT contrato_id FROM contrato_fluxos WHERE contrato_id=$1 FOR UPDATE',[contratoId]);
  await tx.query('SELECT id FROM contrato_versoes WHERE contrato_id=$1 ORDER BY id FOR UPDATE',[contratoId]);
  const sessao=await consultarSessao(context.token,tx,true);
  if(!['ADMINISTRATIVO','REPRESENTANTE_AUTORIZADO'].includes(sessao.papel))recusarFinanceiro('OPERACAO_NAO_AUTORIZADA','Papel não autorizado.',403);
  await tx.query("SELECT id FROM fechamento_revisoes WHERE contrato_id=$1 AND estado IN ('EM_ELABORACAO','CONGELADA') ORDER BY id FOR UPDATE",[contratoId]);
  await tx.query('SELECT p.id FROM pagamentos p JOIN contrato_versoes v ON v.id=p.contrato_versao_id WHERE v.contrato_id=$1 ORDER BY p.id FOR UPDATE OF p',[contratoId]);
  return sessao;
}
export async function registrarEventoFinanceiro(tx:DbExecutor,p:PosicaoFinanceira,s:SessaoAdmin,context:ContextoFinanceiro,input:{tipo:string;chave:string;pedido:unknown;tratamentoId?:string;pendenciaId?:string;justificativa?:string;resultado:Record<string,unknown>;depois?:unknown}){
  await tx.query('INSERT INTO pagamento_gestoes(pagamento_id,contrato_id) VALUES($1,$2) ON CONFLICT(pagamento_id) DO NOTHING',[p.pagamento.id,p.contrato.id]);
  const seq=(await tx.query<{sequencia:string}>('UPDATE pagamento_gestoes SET sequencia=sequencia+1 WHERE pagamento_id=$1 RETURNING sequencia::text',[p.pagamento.id])).rows[0].sequencia;
  const id=randomUUID();
  await tx.query(`INSERT INTO pagamento_eventos(id,pagamento_id,sequencia,pendencia_id,tratamento_id,tipo,chave_idempotencia,pedido_hash,usuario_id,ator_tipo,identidade_snapshot,request_id,sessao_id,ip,user_agent,justificativa,dados_antes,dados_depois,resultado)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'USUARIO',$10,$11,$12,$13,$14,$15,$16,$17,$18)`,[id,p.pagamento.id,seq,input.pendenciaId??null,input.tratamentoId??null,input.tipo,input.chave,hashSnapshotContrato(input.pedido),s.usuario_id,{usuarioId:s.usuario_id,nome:s.nome,cargo:s.cargo,papel:s.papel},context.requestId,s.id,context.ip,context.userAgent,input.justificativa??null,serializarFinanceiro({posicao:p.posicao,versaoReconhecida:p.reconhecida.id,versaoVigente:p.vigente.id,parcelas:p.parcelas,futuro:p.futuro,reservas:p.reservas}),serializarFinanceiro(input.depois??{}),input.resultado]);
  return id;
}
export async function repetirEvento(tx:DbExecutor,pagamentoId:string,chave:string,pedido:unknown,usuarioId:string){
 const e=(await tx.query<{pedido_hash:string;usuario_id:string;resultado:Record<string,unknown>}>('SELECT pedido_hash,usuario_id,resultado FROM pagamento_eventos WHERE pagamento_id=$1 AND chave_idempotencia=$2',[pagamentoId,chave])).rows[0];
 if(!e)return null;
 if(e.pedido_hash!==hashSnapshotContrato(pedido)||e.usuario_id!==usuarioId)recusarFinanceiro('IDEMPOTENCIA_CONFLITANTE','Chave já utilizada para outra operação.');
 return {resultado:e.resultado,reutilizado:true};
}
export function conferirPosicao(p:PosicaoFinanceira,hash:string){if(p.posicaoHash!==hash)recusarFinanceiro('POSICAO_FINANCEIRA_ALTERADA','A posição mudou. Atualize e confira novamente.');}
function pendenciaAtual(p:PosicaoFinanceira,id:string){
 if(p.contrato.status==='CANCELADO'||p.pagamento.status==='CANCELADO')recusarFinanceiro('PAGAMENTO_CANCELADO','Cobrança encerrada. O acerto do cancelamento exige decisão administrativa.');
 const pend=p.pendencias.find(x=>x.id===id);
 if(!pend)recusarFinanceiro('RECURSO_NAO_ENCONTRADO','Pendência não encontrada.',404);
 if(pend.versao_nova_id!==p.vigente.id)recusarFinanceiro('PENDENCIA_SUPERADA','A versão desta pendência não é mais a vigente.');
 if(p.ajustes.some(a=>a.versao_reconhecida_id===p.vigente.id))recusarFinanceiro('PENDENCIA_JA_RESOLVIDA','Versão já reconhecida financeiramente.');
 if(!p.motivos.length)recusarFinanceiro('SEM_IMPACTO_FINANCEIRO','Não há diferença financeira a reconhecer.');
 return pend;
}
export async function iniciarTratamento(contratoId:string,pendenciaId:string,hash:string,chave:string,context:ContextoFinanceiro){return withTransaction(async tx=>{
 const s=await bloquearFinanceiro(tx,contratoId,context),p=await lerPosicaoFinanceira(tx,contratoId),pedido={acao:'iniciar',pendenciaId,hash};
 const retry=await repetirEvento(tx,p.pagamento.id,chave,pedido,s.usuario_id);if(retry)return retry;
 conferirPosicao(p,hash);pendenciaAtual(p,pendenciaId);
 if(p.tratamentos.some(t=>t.pendencia_id===pendenciaId&&t.estado==='EM_TRATAMENTO'))recusarFinanceiro('TRATAMENTO_JA_ABERTO','Já existe tentativa em tratamento.');
 await tx.query('INSERT INTO pagamento_gestoes(pagamento_id,contrato_id) VALUES($1,$2) ON CONFLICT(pagamento_id) DO NOTHING',[p.pagamento.id,contratoId]);
 const id=randomUUID(),tentativa=Math.max(0,...p.tratamentos.filter(t=>t.pendencia_id===pendenciaId).map(t=>t.tentativa))+1;
 await tx.query("INSERT INTO pagamento_tratamentos(id,pendencia_id,pagamento_id,tentativa,estado,posicao_base_hash,iniciado_por_usuario_id) VALUES($1,$2,$3,$4,'EM_TRATAMENTO',$5,$6)",[id,pendenciaId,p.pagamento.id,tentativa,hash,s.usuario_id]);
 const resultado={tratamentoId:id,tentativa};
 await registrarEventoFinanceiro(tx,p,s,context,{tipo:'TRATAMENTO_INICIADO',chave,pedido,pendenciaId,tratamentoId:id,resultado});
 return{resultado,reutilizado:false};
});}
export async function cancelarTratamento(contratoId:string,id:string,motivo:string,chave:string,context:ContextoFinanceiro){return withTransaction(async tx=>{
 const s=await bloquearFinanceiro(tx,contratoId,context),p=await lerPosicaoFinanceira(tx,contratoId),pedido={acao:'cancelar',id,motivo};
 const retry=await repetirEvento(tx,p.pagamento.id,chave,pedido,s.usuario_id);if(retry)return retry;
 const t=p.tratamentos.find(t=>t.id===id);if(!t||t.estado!=='EM_TRATAMENTO')recusarFinanceiro('TRATAMENTO_INDISPONIVEL','Tentativa não está aberta.');
 if(!motivo.trim())recusarFinanceiro('DADOS_INVALIDOS','Informe motivo.',400);
 await tx.query("UPDATE pagamento_tratamentos SET estado='CANCELADA',encerrado_em=clock_timestamp(),motivo_encerramento=$2 WHERE id=$1",[id,motivo]);
 const resultado={tratamentoId:id,estadoTentativa:'CANCELADA',situacaoAlteracao:p.motivos.length?'PENDENTE':'SEM_PENDENCIA'};
 await registrarEventoFinanceiro(tx,p,s,context,{tipo:'TRATAMENTO_CANCELADO',chave,pedido,tratamentoId:id,pendenciaId:t.pendencia_id,justificativa:motivo,resultado});return{resultado,reutilizado:false};
});}
export function simularPosicao(p:PosicaoFinanceira,input:PedidoResolucao,reprogramacao=false){
 if(p.contrato.status==='CANCELADO'||p.pagamento.status==='CANCELADO')recusarFinanceiro('PAGAMENTO_CANCELADO','Cobrança encerrada não pode ser reprogramada.');
 conferirPosicao(p,input.posicaoHash);
 const alvo=reprogramacao?p.posicao.obrigacao:p.valorVigente;
 const delta=alvo-p.posicao.obrigacao;
 const depois=posicaoEconomica(alvo,0n,p.posicao.recebido,p.posicao.estornado,p.posicao.devolvido,p.posicao.reservado);
 const aproveitado=delta>0n?(delta<p.posicao.credito?delta:p.posicao.credito):0n;
 // Sem crédito remanescente, a absorção é apenas consequência de obrigação − líquido.
 // O valor "aproveitado" é informativo no ajuste; não cria movimento nem novo abatimento.
 if(depois.credito>0n&&aproveitado>0n&&input.credito!=='APROVEITAR')recusarFinanceiro('DECISAO_CREDITO_OBRIGATORIA','Confirme o aproveitamento do crédito na obrigação adicional desta contratação.');
 if(depois.credito>0n&&input.credito!=='MANTER'&&input.credito!=='APROVEITAR')recusarFinanceiro('DECISAO_CREDITO_OBRIGATORIA','Confirme a manutenção do crédito. A devolução pode ser solicitada em seguida.');
 if(p.motivos.includes('CONTRATANTE')&&!reprogramacao&&input.decisaoContratante==='NAO_SE_APLICA')recusarFinanceiro('DECISAO_CONTRATANTE_OBRIGATORIA','Registre a autorização de aproveitamento dos valores.');
 if(input.decisaoContratante==='DEVOLUCAO_AO_PAGADOR_ANTERIOR'&&depois.disponivel===0n)recusarFinanceiro('CREDITO_INDISPONIVEL','A devolução ao pagador anterior exige crédito disponível. Não pode reabrir saldo a receber.');
 if(!input.justificativa.trim())recusarFinanceiro('DADOS_INVALIDOS','Informe a justificativa.',400);
 if((depois.saldo===0n)!==(input.modo==='SEM_SALDO'))recusarFinanceiro('CRONOGRAMA_INCONSISTENTE','Tratamento incompatível com saldo.',422);
 const versao=reprogramacao?p.reconhecida:p.vigente;
 validarCronogramaConsolidado(input.parcelas,depois.saldo,versao.snapshot.evento.data,(versao.snapshot.comercial.condicaoPagamento?.forma??versao.snapshot.comercial.formaPagamentoPretendida)==='PIX_PARCELADO');
 for(const parcela of input.parcelas.filter(i=>i.parcelaId)){
  const antiga=p.futuro.find(i=>i.parcelaId===parcela.parcelaId?.toLowerCase());
  if(!antiga||antiga.vencimento!==parcela.vencimento||BigInt(antiga.valorCentavos)!==centavosInteiros(parcela.valorCentavos))recusarFinanceiro('PARCELA_NAO_PRESERVAVEL','Parcela preservada deve manter seu saldo e vencimento.');
 }
 if(input.modo==='MANTER_E_COMPLEMENTAR'&&p.futuro.filter(i=>BigInt(i.valorCentavos)>0n).some(i=>!input.parcelas.some(n=>n.parcelaId?.toLowerCase()===i.parcelaId)))recusarFinanceiro('CRONOGRAMA_INCONSISTENTE','Mantenha todas as parcelas futuras nesta opção.',422);
 if(p.recebimentos.some(r=>r.status==='PENDENTE'))recusarFinanceiro('RECEBIMENTO_PENDENTE','Confirme ou trate os recebimentos pendentes antes de reorganizar o cronograma.');
 return {delta,depois,aproveitado,parcelas:input.parcelas};
}
export async function simularAlteracao(contratoId:string,id:string,input:PedidoResolucao){return withTransaction(async tx=>{const p=await lerPosicaoFinanceira(tx,contratoId);const t=p.tratamentos.find(t=>t.id===id&&t.estado==='EM_TRATAMENTO');if(!t)recusarFinanceiro('TRATAMENTO_INDISPONIVEL','Tentativa não está aberta.');pendenciaAtual(p,t.pendencia_id);return serializarFinanceiro(simularPosicao(p,input));});}
export async function resolverAlteracao(contratoId:string,id:string,input:PedidoResolucao,chave:string,context:ContextoFinanceiro){return withTransaction(async tx=>{
 const s=await bloquearFinanceiro(tx,contratoId,context),p=await lerPosicaoFinanceira(tx,contratoId),pedido={acao:'resolver',id,...input};
 const retry=await repetirEvento(tx,p.pagamento.id,chave,pedido,s.usuario_id);if(retry)return retry;
 const t=p.tratamentos.find(t=>t.id===id&&t.estado==='EM_TRATAMENTO');if(!t)recusarFinanceiro('TRATAMENTO_INDISPONIVEL','Tentativa não está aberta.');pendenciaAtual(p,t.pendencia_id);
 const simulacao=simularPosicao(p,input),ajusteId=randomUUID(),cronogramaId=randomUUID(),resultado={tratamentoId:id,ajusteId,cronogramaId,obrigacaoCentavos:simulacao.depois.obrigacao.toString(),saldoCentavos:simulacao.depois.saldo.toString(),creditoCentavos:simulacao.depois.credito.toString()};
 const eventoId=await registrarEventoFinanceiro(tx,p,s,context,{tipo:'ALTERACAO_RESOLVIDA',chave,pedido,pendenciaId:t.pendencia_id,tratamentoId:id,justificativa:input.justificativa,resultado,depois:simulacao});
 await tx.query(`INSERT INTO pagamento_ajustes_contratuais(id,pagamento_id,tratamento_id,evento_id,ajuste_anterior_id,versao_base_financeira_id,versao_reconhecida_id,obrigacao_antes_centavos,delta_centavos,obrigacao_depois_centavos,credito_aproveitado_centavos,tratamento_saldo,decisao_contratante,justificativa) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,[ajusteId,p.pagamento.id,id,eventoId,p.ajustes.at(-1)?.id??null,p.reconhecida.id,p.vigente.id,p.posicao.obrigacao.toString(),simulacao.delta.toString(),simulacao.depois.obrigacao.toString(),simulacao.aproveitado.toString(),input.modo,input.decisaoContratante,input.justificativa]);
 for(const r of p.recebimentos.filter(r=>r.status==='CONFIRMADO'))await tx.query('INSERT INTO pagamento_ajuste_bases(ajuste_id,recebimento_id,valor_centavos,fato_em) VALUES($1,$2,$3,$4)',[ajusteId,r.id,reaisCentavos(r.valor_bruto).toString(),r.confirmado_em]);
 for(const e of p.estornos.filter(e=>e.status==='CONFIRMADO'))await tx.query('INSERT INTO pagamento_ajuste_bases(ajuste_id,estorno_id,valor_centavos,fato_em) VALUES($1,$2,$3,$4)',[ajusteId,e.id,reaisCentavos(e.valor).toString(),e.confirmado_em]);
 for(const d of p.devolucoes.filter(d=>d.estado==='CONCLUIDA'))await tx.query('INSERT INTO pagamento_ajuste_bases(ajuste_id,devolucao_id,valor_centavos,fato_em) VALUES($1,$2,$3,$4)',[ajusteId,d.id,d.valor_centavos,d.devolvido_em]);
 await gravarCronograma(tx,p,input,{id:cronogramaId,eventoId,ajusteId,usuarioId:s.usuario_id,saldo:simulacao.depois.saldo,versao:p.vigente});
 await tx.query("UPDATE pagamento_tratamentos SET estado='RESOLVIDA',encerrado_em=clock_timestamp() WHERE id=$1",[id]);
 const final=await lerPosicaoFinanceira(tx,contratoId);if(final.vigente.id!==p.vigente.id||final.posicao.obrigacao!==p.valorVigente)recusarFinanceiro('POSICAO_FINANCEIRA_ALTERADA','Versão vigente alterada durante a confirmação.');
 return{resultado,reutilizado:false};
});}
