import type { DbExecutor } from '../db/contracts.ts';

export async function auditarMovimentoPreReserva(tx: DbExecutor, ator: { usuarioId: string } | { clienteId: string },
  acao: 'PRE_RESERVA_SINAL_CONFIRMADO' | 'PRE_RESERVA_DEVOLUCAO_ASSUMIDA' | 'PRE_RESERVA_DEVOLUCAO_CONFIRMADA' |
    'PRE_RESERVA_CREDITO_REVERTIDO' | 'PRE_RESERVA_ACEITE' | 'PRE_RESERVA_DESISTENCIA',
  empresaId: string, fechamentoId: string, movimento: string, instante: Date | string,
  reversao?: { motivo: string; contratoId: string; versaoId?: string },
) {
  const usuario = 'usuarioId' in ator;
  await tx.query(`INSERT INTO auditoria (ator_tipo,usuario_id,cliente_id,acao,entidade_tipo,entidade_id,origem,dados_depois)
    VALUES($1,$2,$3,$4,'FECHAMENTO',$5,'PRE_RESERVA',$6::jsonb)`, [
    usuario ? 'USUARIO' : 'CLIENTE', usuario ? ator.usuarioId : null, usuario ? null : ator.clienteId,
    acao, fechamentoId, JSON.stringify({ empresaId, fechamentoId, movimento, instante, ...reversao }),
  ]);
}
