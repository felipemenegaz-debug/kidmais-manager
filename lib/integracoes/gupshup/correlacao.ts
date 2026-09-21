import { createHash } from 'node:crypto';

/** Identificador operacional estável; nunca registrar o ID bruto do provedor. */
export function messageIdHash(messageId: string): string {
    return createHash('sha256').update(messageId).digest('hex').slice(0, 16);
}
