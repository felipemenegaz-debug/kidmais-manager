import { randomUUID } from 'node:crypto';
import type { DbExecutor } from '../db/contracts';

/**
 * Auditoria mínima dos créditos (tabela `auditoria`, origem CREDITOS_IA): protocolo, tipo, recurso, quantidade, valor e
 * resultado. Nunca nome, CPF, e-mail, cartão, contato, prompt, foto ou URL de fatura.
 */
export async function auditarCreditos(tx: DbExecutor, a: { usuarioId: string | null; acao: string; entidadeTipo: string; entidadeId: string;
    dados: Record<string, string | number | boolean | null>; requestId?: string | null }) {
    await tx.query(`INSERT INTO auditoria (ator_tipo, usuario_id, acao, entidade_tipo, entidade_id, dados_depois, origem, request_id)
        VALUES ($1, $2::uuid, $3, $4, $5::uuid, $6::jsonb, 'CREDITOS_IA', $7::uuid)`,
    [a.usuarioId ? 'USUARIO' : 'SISTEMA', a.usuarioId, a.acao, a.entidadeTipo, a.entidadeId, JSON.stringify(a.dados), a.requestId ?? randomUUID()]);
}
