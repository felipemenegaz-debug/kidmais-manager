import type {DbExecutor} from '../../db/contracts';
import type {SessaoAdmin} from '../../autenticacao/service';
import {registrarEventoHistorico} from '../../clientes/repositories/historico.repository';
import {registrarAuditoria} from '../../clientes/repositories/auditoria.repository';
import {exigir} from '../../festas/domain';
/** Comando contratual interno: chamado com contrato, sessão e Festa bloqueados na mesma transação. */
export async function cancelarContratacaoDaFesta(tx:DbExecutor,id:string,s:SessaoAdmin,motivo:string,chave:string,ctx:{requestId:string;userAgent:string|null}){
 exigir(motivo.trim().length>=3,'Informe por que a festa está sendo cancelada.',400);
 exigir((await tx.query("SELECT id FROM festa_usuario_capacidades WHERE usuario_id=$1 AND capacidade='FESTA_CORRIGIR' AND revogado_em IS NULL",[s.usuario_id])).rows.length,'Somente a Gestão pode cancelar a contratação.',403);
 const c=(await tx.query<{id:string;status:string;cancelado_em:string|null;cliente_id:string}>('SELECT c.*,f.cliente_id FROM contratos c JOIN fechamentos f ON f.id=c.fechamento_id WHERE c.id=$1 FOR UPDATE OF c',[id])).rows[0];
 exigir(c,'Contratação não encontrada.',404);
 exigir(!(await tx.query("SELECT cc.id FROM festa_contagens_convidados cc JOIN festas f ON f.id=cc.festa_id WHERE f.contrato_id=$1 AND cc.total_presentes>0 AND NOT EXISTS(SELECT 1 FROM festa_contagens_convidados cor WHERE cor.corrige_contagem_id=cc.id) UNION ALL SELECT r.id FROM festa_solicitacoes r JOIN festas f ON f.id=r.festa_id WHERE f.contrato_id=$1 AND r.tipo IN ('HORA_EXTRA','ADICIONAL') AND r.cancelado_em IS NULL",[id])).rows.length,'Há registros de convidados presentes, hora extra ou adicionais que indicam realização. Confira e corrija os registros, se estiverem errados, antes de cancelar.');
 const anterior=(await tx.query<{metadata:Record<string,unknown>}>("SELECT metadata FROM eventos_historico_cliente WHERE entidade_tipo='CONTRATO' AND entidade_id=$1 AND tipo_evento='CONTRATO_CANCELADO' ORDER BY criado_em DESC LIMIT 1",[id])).rows[0];
 if(c.status==='CANCELADO'){exigir(anterior&&anterior.metadata.chave===chave&&anterior.metadata.usuarioId===s.usuario_id&&anterior.metadata.motivo===motivo,'A contratação já foi cancelada. Consulte o histórico.');return anterior.metadata;}
 exigir(c.status==='ASSINADO'&&!c.cancelado_em,'A contratação precisa estar ativa e assinada para este cancelamento.');
 const cancelado=(await tx.query<{cancelado_em:string}>("UPDATE contratos SET status='CANCELADO',cancelado_em=clock_timestamp() WHERE id=$1 RETURNING cancelado_em::text",[id])).rows[0];
 const detail={contratoId:id,motivo,usuarioId:s.usuario_id,nome:s.nome,papel:s.papel,canceladoEm:cancelado.cancelado_em,chave};
 await registrarEventoHistorico({clienteId:c.cliente_id,tipoEvento:'CONTRATO_CANCELADO',origem:'CONTRATO_ADMIN',entidadeTipo:'CONTRATO',entidadeId:id,usuarioId:s.usuario_id,detalhe:motivo,metadata:detail,critico:true},tx);
 await registrarAuditoria({clienteId:c.cliente_id,atorTipo:'USUARIO',usuarioId:s.usuario_id,acao:'CONTRATO_CANCELADO',origem:'CONTRATO_ADMIN',entidadeTipo:'CONTRATO',entidadeId:id,dadosAntes:{status:c.status,canceladoEm:c.cancelado_em},dadosDepois:detail,justificativa:motivo,requestId:ctx.requestId,userAgent:ctx.userAgent},tx);
 return detail;
}
