import { escopoCotacaoPublica } from '../../../comercial/cotacao-publica.ts';
import type { DbExecutor } from '../../../db/contracts.ts';
import { enderecoPublicoAbsoluto } from '../../../fechamentos/rota-publica.ts';

/**
 * Rodada 40: link da página PÚBLICA de disponibilidade/fechamento (/disponibilidade → /fechamento) para o cliente
 * escolher a festa sozinho. É o mesmo link para todos os clientes da empresa — diferente do link individual de contrato
 * (/contrato/{id}, protegido por CPF + código), que só vai para quem já tem contratação.
 *
 * A página global atende AGENDA_PUBLICA_EMPRESA_ID. As demais empresas usam o próprio endereço público quando elegíveis.
 * A URL não leva parâmetros:
 * a página não aceita dados pré-preenchidos fora da escolha feita nela, e dado pessoal nunca vai na URL.
 * Enviar o link não reserva nada: a data só fica garantida com a contratação concluída.
 */
/** AGENDA_PUBLICA_ORIGEM: endereço da página pública, quando difere do sistema (senão, ADMIN_AUTH_ORIGIN). */
export type AmbienteLinkDisponibilidade = { AGENDA_PUBLICA_EMPRESA_ID?: string; AGENDA_PUBLICA_ORIGEM?: string; ADMIN_AUTH_ORIGIN?: string; SITE_URL?: string };
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

type DependenciasLink = {
  lerCodigo: (conexao: () => DbExecutor, empresaId: string) => Promise<string | null>;
  escopo: (conexao: () => DbExecutor, codigo: string) => Promise<{ empresaId: string }>;
};

const dependenciasLink: DependenciasLink = {
  async lerCodigo(conexao, empresaId) {
    const { rows } = await conexao().query<{ codigo: string }>(
      'SELECT codigo FROM public.empresas WHERE id = $1::uuid', [empresaId],
    );
    return rows[0]?.codigo ?? null;
  },
  escopo: escopoCotacaoPublica,
};

export async function linkDisponibilidadeDaEmpresa(
  empresaId: string,
  env: AmbienteLinkDisponibilidade,
  conexao: () => DbExecutor,
  deps: DependenciasLink = dependenciasLink,
): Promise<EstadoLinkDisponibilidade | { ok: false; motivo: 'PAGINA_INDISPONIVEL' }> {
  const publica = env.AGENDA_PUBLICA_EMPRESA_ID?.trim();
  const empresa = empresaId.trim().toLowerCase();
  if (publica && publica.toLowerCase() === empresa) return linkDisponibilidadePublica(empresaId, env);

  const indisponivel = { ok: false, motivo: 'PAGINA_INDISPONIVEL' } as const;
  try {
    const codigo = await deps.lerCodigo(conexao, empresa);
    if (!codigo) return indisponivel;
    const link = enderecoPublicoAbsoluto(env.SITE_URL || env.ADMIN_AUTH_ORIGIN, codigo, '/disponibilidade');
    if (!link) return indisponivel;
    const escopo = await deps.escopo(conexao, codigo);
    if (escopo.empresaId !== empresa) return indisponivel;
    return { ok: true, link };
  } catch {
    return indisponivel;
  }
}

/** Só as variáveis usadas para escolher o endereço do link. */
export const ambienteDoLink = (): AmbienteLinkDisponibilidade => ({
  AGENDA_PUBLICA_EMPRESA_ID: process.env.AGENDA_PUBLICA_EMPRESA_ID,
  AGENDA_PUBLICA_ORIGEM: process.env.AGENDA_PUBLICA_ORIGEM,
  ADMIN_AUTH_ORIGIN: process.env.ADMIN_AUTH_ORIGIN,
  SITE_URL: process.env.SITE_URL,
});
