/**
 * Rodada 40: link da página PÚBLICA de disponibilidade/fechamento (/disponibilidade → /fechamento) para o cliente
 * escolher a festa sozinho. É o mesmo link para todos os clientes da empresa — diferente do link individual de contrato
 * (/contrato/{id}, protegido por CPF + código), que só vai para quem já tem contratação.
 *
 * A página pública atende UMA empresa por servidor (AGENDA_PUBLICA_EMPRESA_ID): o link só é oferecido quando ela é a
 * empresa desta conversa; para outra empresa não há link (nunca a agenda de outro tenant). A URL não leva parâmetros:
 * a página não aceita dados pré-preenchidos fora da escolha feita nela, e dado pessoal nunca vai na URL.
 * Enviar o link não reserva nada: a data só fica garantida com a contratação concluída.
 */
/** AGENDA_PUBLICA_ORIGEM: endereço da página pública, quando difere do sistema (senão, ADMIN_AUTH_ORIGIN). */
export type AmbienteLinkDisponibilidade = { AGENDA_PUBLICA_EMPRESA_ID?: string; AGENDA_PUBLICA_ORIGEM?: string; ADMIN_AUTH_ORIGIN?: string };
export type EstadoLinkDisponibilidade =
  | { ok: true; link: string }
  | { ok: false; motivo: 'OUTRA_EMPRESA' | 'NAO_CONFIGURADO' | 'ORIGEM_NAO_SEGURA' };

const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]']);

export function linkDisponibilidadePublica(empresaId: string, env: AmbienteLinkDisponibilidade): EstadoLinkDisponibilidade {
  const publica = env.AGENDA_PUBLICA_EMPRESA_ID?.trim();
  if (!publica) return { ok: false, motivo: 'NAO_CONFIGURADO' };
  if (publica.toLowerCase() !== empresaId.trim().toLowerCase()) return { ok: false, motivo: 'OUTRA_EMPRESA' };
  let u: URL;
  try { u = new URL(env.AGENDA_PUBLICA_ORIGEM?.trim() || env.ADMIN_AUTH_ORIGIN || ''); } catch { return { ok: false, motivo: 'ORIGEM_NAO_SEGURA' }; }
  if (u.pathname !== '/' || u.search || u.hash || u.username || u.password) return { ok: false, motivo: 'ORIGEM_NAO_SEGURA' };
  // http só no endereço local da própria máquina (demo/desenvolvimento); qualquer outro endereço exige https.
  const seguro = u.protocol === 'https:' || (u.protocol === 'http:' && LOCAL.has(u.hostname));
  if (!seguro) return { ok: false, motivo: 'ORIGEM_NAO_SEGURA' };
  return { ok: true, link: `${u.origin}/disponibilidade` };
}

/** Só as três variáveis do link, lidas do ambiente do processo (nada além delas). */
export const ambienteDoLink = (): AmbienteLinkDisponibilidade => ({
  AGENDA_PUBLICA_EMPRESA_ID: process.env.AGENDA_PUBLICA_EMPRESA_ID, AGENDA_PUBLICA_ORIGEM: process.env.AGENDA_PUBLICA_ORIGEM, ADMIN_AUTH_ORIGIN: process.env.ADMIN_AUTH_ORIGIN,
});
