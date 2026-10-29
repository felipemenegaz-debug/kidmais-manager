import { randomUUID } from 'node:crypto';
import type { DbExecutor } from '../db/contracts';

/** Auditoria da cobrança (origem COBRANCA), separada para ser usada pela sincronização e pela reconciliação sem ciclo de import. */
export const ORIGEM_COBRANCA = 'COBRANCA';
/**
 * `RECUPERACAO_B14` (plano rev. 8.1, §3.4): a recuperação de pagamentos passa `requestId` = id da execução e `caso` = id opaco
 * do caso, para o `conferir-caso` localizar a auditoria pela origem depois de um COMMIT sem resposta. Os demais não mudam.
 */
export type OrigemSincronizacao = { tipo: 'WEBHOOK' | 'RECONCILIACAO' | 'GESTAO' | 'DESENVOLVEDOR' | 'RECUPERACAO_B14'; usuarioId?: string | null; requestId?: string | null;
    eventoId?: string | null; caso?: string | null };

/** Auditoria da cobrança: ator SISTEMA (webhook/reconciliação) ou a pessoa que pediu; nunca valores ou dados pessoais. */
export async function auditarCobranca(tx: DbExecutor, input: {
    acao: string; empresaId: string; origem: OrigemSincronizacao; antes?: Record<string, unknown> | null; depois?: Record<string, unknown> | null; justificativa?: string | null; ip?: string | null;
}) {
    const usuarioId = input.origem.usuarioId ?? null;
    await tx.query(
        `INSERT INTO auditoria (ator_tipo, usuario_id, acao, entidade_tipo, entidade_id, dados_antes, dados_depois, justificativa, origem, request_id, ip)
         VALUES ($1, $2::uuid, $3, 'EMPRESA_ASSINATURA', $4::uuid, $5::jsonb, $6::jsonb, $7, $8, $9::uuid, $10::inet)`,
        [usuarioId ? 'USUARIO' : 'SISTEMA', usuarioId, input.acao, input.empresaId, input.antes ? JSON.stringify(input.antes) : null,
            JSON.stringify({ ...(input.depois ?? {}), empresaId: input.empresaId, via: input.origem.tipo, eventoId: input.origem.eventoId ?? null,
                ...(input.origem.caso ? { caso: input.origem.caso } : {}) }),
            input.justificativa ?? null, ORIGEM_COBRANCA, input.origem.requestId ?? randomUUID(), input.ip ?? null]);
}
