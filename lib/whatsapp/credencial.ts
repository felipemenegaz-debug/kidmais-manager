import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { AmbienteWhatsapp } from './configuracao.ts';
import { WhatsappOnboardingError } from './errors.ts';

export type IdentidadeCredencialWhatsapp = { ambiente: AmbienteWhatsapp; appId: string; businessId: string; wabaId: string; phoneNumberId: string };
function aad(meta: IdentidadeCredencialWhatsapp) { return Buffer.from(JSON.stringify([meta.ambiente, meta.appId, meta.businessId, meta.wabaId, meta.phoneNumberId]), 'utf8'); }

export function carregarChaveCredencial(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env) {
  const raw = env.WHATSAPP_CREDENTIAL_ENCRYPTION_KEY?.trim() ?? '';
  const version = Number(env.WHATSAPP_CREDENTIAL_KEY_VERSION);
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32 || !Number.isSafeInteger(version) || version <= 0) {
    throw new WhatsappOnboardingError('CREDENCIAL_CRIPTOGRAFIA_INVALIDA', 'Configuração segura da credencial WhatsApp indisponível.', 503);
  }
  return { key, version };
}

export function cifrarCredencialWhatsapp(token: string, meta: IdentidadeCredencialWhatsapp, env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env) {
  if (!token || token.length > 16_384) throw new WhatsappOnboardingError('META_TOKEN_INVALIDO', 'A Meta não retornou uma credencial válida.', 502);
  const { key, version } = carregarChaveCredencial(env);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad(meta));
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return { ciphertext, iv, tag: cipher.getAuthTag(), keyVersion: version };
}

export function decifrarCredencialWhatsapp(input: { ciphertext: Buffer; iv: Buffer; tag: Buffer }, meta: IdentidadeCredencialWhatsapp, env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env) {
  const { key } = carregarChaveCredencial(env);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, input.iv);
    decipher.setAAD(aad(meta));
    decipher.setAuthTag(input.tag);
    return Buffer.concat([decipher.update(input.ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new WhatsappOnboardingError('CREDENCIAL_INTEGRIDADE_INVALIDA', 'A credencial WhatsApp armazenada não passou na verificação de integridade.', 503);
  }
}
