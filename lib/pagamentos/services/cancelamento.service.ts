import type { DbExecutor } from '../../db/contracts';
import type { SessaoAdmin } from '../../autenticacao/service';
import { registrarAuditoria } from '../../clientes/repositories/auditoria.repository';
import { registrarEventoHistorico } from '../../clientes/repositories/historico.repository';

/** Usa a transação e os locks da contratação; nunca efetua estorno ou devolução. */
export async function cancelarFinanceiroDaContratacao(
  tx: DbExecutor, contratoId: string, clienteId: string, sessao: SessaoAdmin,
  motivo: string, chave: string, ctx: { requestId: string; userAgent: string | null },
) {
  const pagamentos = (await tx.query<{ id: string; status: string }>(
    `SELECT p.id,p.status FROM pagamentos p JOIN contrato_versoes v ON v.id=p.contrato_versao_id
     WHERE v.contrato_id=$1 ORDER BY p.id FOR UPDATE OF p`, [contratoId],
  )).rows;
  for (const pagamento of pagamentos) {
    if (pagamento.status === 'CANCELADO') continue;
    const recebimentos = (await tx.query<{ quantidade: number; confirmado: string }>(
      `SELECT count(*)::int quantidade,coalesce(sum(valor_bruto) FILTER (WHERE status='CONFIRMADO'),0)::text confirmado
       FROM pagamento_recebimentos WHERE pagamento_id=$1`, [pagamento.id],
    )).rows[0];
    // Inclui parcelas preservadas por um cronograma consolidado, sem mudar planos históricos.
    const parcelas = await tx.query<{ id: string }>(
      `UPDATE pagamento_parcelas pp SET status='CANCELADA' FROM pagamento_planos pl
       WHERE pp.plano_id=pl.id AND pl.pagamento_id=$1
       AND pp.status IN ('PENDENTE','PARCIALMENTE_PAGA','ESTORNADA')
       AND (pl.status='ATIVO' OR EXISTS (
         SELECT 1 FROM pagamento_cronograma_itens i JOIN pagamento_cronogramas cr ON cr.id=i.cronograma_id
         WHERE i.parcela_id=pp.id AND cr.pagamento_id=$1 AND cr.estado='ATIVO')) RETURNING pp.id`, [pagamento.id],
    );
    const planos = await tx.query<{ id: string }>(
      `UPDATE pagamento_planos SET status='CANCELADO',cancelado_em=clock_timestamp()
       WHERE pagamento_id=$1 AND status='ATIVO' RETURNING id`, [pagamento.id],
    );
    await tx.query("UPDATE pagamentos SET status='CANCELADO',cancelado_em=clock_timestamp() WHERE id=$1", [pagamento.id]);
    // A 015 exige o cronograma canônico mesmo após cancelamento. Ele permanece como
    // referência histórica; as consultas suprimem cobrança quando a obrigação é cancelada.
    const dados = { contratoId, chave, status: 'CANCELADO', planos: planos.rows.map(p => p.id),
      parcelas: parcelas.rows.map(p => p.id), recebimentosPreservados: recebimentos.quantidade,
      valorConfirmadoPreservado: recebimentos.confirmado, acertoAdministrativoPendente: recebimentos.quantidade > 0 };
    await registrarEventoHistorico({ clienteId, tipoEvento: 'PAGAMENTO_CANCELADO', origem: 'CONTRATO_ADMIN',
      entidadeTipo: 'PAGAMENTO', entidadeId: pagamento.id, usuarioId: sessao.usuario_id,
      detalhe: motivo, metadata: dados, critico: true }, tx);
    await registrarAuditoria({ clienteId, atorTipo: 'USUARIO', usuarioId: sessao.usuario_id,
      acao: 'PAGAMENTO_CANCELADO', entidadeTipo: 'PAGAMENTO', entidadeId: pagamento.id,
      dadosAntes: { status: pagamento.status }, dadosDepois: dados, justificativa: motivo,
      origem: 'CONTRATO_ADMIN', requestId: ctx.requestId, userAgent: ctx.userAgent }, tx);
  }
}
