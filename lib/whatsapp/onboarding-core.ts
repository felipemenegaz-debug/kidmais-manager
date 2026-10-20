import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { DbExecutor } from '../db/contracts.ts';
import { WhatsappOnboardingError } from './errors.ts';

const JANELA_REAUTENTICACAO_MS = 5 * 60 * 1000;
export const PAPEL_GESTAO = 'REPRESENTANTE_AUTORIZADO';
const idMeta = z.string().regex(/^[0-9]+$/).max(64);
export const concluirOnboardingSchema = z.object({
  tentativaId: z.uuid(), state: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  // Fluxo do WhatsApp Business App: o evento oficial pode trazer só waba_id; negócio e número são então resolvidos e
  // comprovados no servidor (meta-client). Quando vêm, continuam conferidos.
  authorizationCode: z.string().min(8).max(8192), businessId: idMeta.optional(), wabaId: idMeta, phoneNumberId: idMeta.optional(),
}).strict();
export const desconectarSchema = z.object({ conexaoId: z.uuid(), motivo: z.string().trim().min(3).max(500) }).strict();

/**
 * WhatsApp é da EMPRESA (083): cada empresa conecta o próprio número. Só a Gestão DELA pode consultar, conectar ou
 * desconectar — o papel da membership comprovada pelo tenant (`papelAtual`), nunca o papel da identidade global.
 */
export function exigirGestaoDaEmpresa(papelNaEmpresa: string, acao: string) {
  if (papelNaEmpresa !== PAPEL_GESTAO) throw new WhatsappOnboardingError('WHATSAPP_AUTORIZACAO_RECUSADA', `Somente a Gestão da empresa pode ${acao} o WhatsApp.`, 403);
}

/** Conectar e desconectar exigem a senha reconfirmada nos últimos 5 minutos. */
export function exigirReautenticacaoRecente(sessao: { autenticado_em: string }, agora = Date.now()) {
  const autenticado = new Date(sessao.autenticado_em).getTime();
  if (!Number.isFinite(autenticado) || agora - autenticado > JANELA_REAUTENTICACAO_MS) {
    throw new WhatsappOnboardingError('WHATSAPP_REAUTENTICACAO_NECESSARIA', 'Confirme sua senha novamente antes de configurar o WhatsApp.', 403);
  }
}

/**
 * O código do WhatsApp por empresa pode chegar ao servidor antes da 083 (o aplicador roda no Shell do serviço já
 * publicado): sem as colunas, responde 503 com mensagem clara em vez de erro de SQL.
 */
export async function exigirEsquemaPorEmpresa(tx: DbExecutor) {
  const ok = (await tx.query<{ ok: boolean }>(`SELECT (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public'
      AND column_name = 'empresa_id' AND table_name IN ('whatsapp_conexoes', 'whatsapp_onboarding_tentativas')) = 2 AS ok`)).rows[0]?.ok === true;
  if (!ok) throw new WhatsappOnboardingError('WHATSAPP_ATUALIZACAO_PENDENTE', 'A conexão do WhatsApp por empresa fica disponível depois da atualização do banco. Tente novamente mais tarde.', 503);
}

export function hashState(state: string) { return createHash('sha256').update(state, 'utf8').digest(); }
export function stateCorresponde(state: string, esperado: Buffer) {
  const atual = hashState(state);
  return atual.length === esperado.length && timingSafeEqual(atual, esperado);
}
