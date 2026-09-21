import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { WhatsappOnboardingError } from './errors.ts';

const JANELA_REAUTENTICACAO_MS = 5 * 60 * 1000;
const idMeta = z.string().regex(/^[0-9]+$/).max(64);
export const concluirOnboardingSchema = z.object({
  tentativaId: z.uuid(), state: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  authorizationCode: z.string().min(8).max(8192), businessId: idMeta, wabaId: idMeta, phoneNumberId: idMeta,
}).strict();

export function exigirRepresentanteRecente(sessao: { papel: string; autenticado_em: string }, agora = Date.now()) {
  if (sessao.papel !== 'REPRESENTANTE_AUTORIZADO') throw new WhatsappOnboardingError('WHATSAPP_AUTORIZACAO_RECUSADA', 'Somente representante autorizado pode configurar o WhatsApp.', 403);
  const autenticado = new Date(sessao.autenticado_em).getTime();
  if (!Number.isFinite(autenticado) || agora - autenticado > JANELA_REAUTENTICACAO_MS) {
    throw new WhatsappOnboardingError('WHATSAPP_REAUTENTICACAO_NECESSARIA', 'Confirme sua senha novamente antes de configurar o WhatsApp.', 403);
  }
}

export function hashState(state: string) { return createHash('sha256').update(state, 'utf8').digest(); }
export function stateCorresponde(state: string, esperado: Buffer) {
  const atual = hashState(state);
  return atual.length === esperado.length && timingSafeEqual(atual, esperado);
}
