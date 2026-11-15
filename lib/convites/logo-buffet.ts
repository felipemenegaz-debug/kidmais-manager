import type { DbExecutor } from '../db/contracts.ts';
import { EMPRESA_SAAS_DO_PERFIL } from '../perfil/autorizacao.ts';

/**
 * Logo do buffet no rodapé da página pública do convite (sem migration).
 *
 * - Padrão do buffet: `logoNosConvites` no conteúdo da revisão APLICADA do Perfil da empresa (ausente = ligado).
 *   Vale só para convites criados depois: é copiado para o rascunho na criação.
 * - Escolha por convite: `logoBuffet` no conteúdo do convite (rascunho e publicado). Ausente = ligado.
 *   Só o buffet muda (ação `logo_buffet`, que grava rascunho e publicado juntos, sem republicar);
 *   salvar ou publicar sempre preserva o valor gravado, venha o que vier da tela (família inclusive).
 * - A arte e o download não mudam; a logo é servida à parte (`?logo=1`).
 */
export type MarcaBuffet = { logoDataUrl: string | null; padrao: boolean };
const SEM_MARCA: MarcaBuffet = { logoDataUrl: null, padrao: true };

export function mostrarLogoBuffet(conteudo: { logoBuffet?: boolean } | null | undefined) {
  return conteudo?.logoBuffet !== false;
}

/** O valor gravado prevalece sobre o enviado pela tela; sem valor gravado, o campo fica ausente (= ligado). */
export function preservarLogoBuffet<T extends { logoBuffet?: boolean }>(novo: T, gravado: { logoBuffet?: boolean } | null | undefined): T {
  const { logoBuffet: _enviado, ...resto } = novo;
  void _enviado;
  return (typeof gravado?.logoBuffet === 'boolean' ? { ...resto, logoBuffet: gravado.logoBuffet } : resto) as T;
}

/** A família não recebe o campo: o controle é só do buffet. */
export function semLogoBuffet<T extends { logoBuffet?: boolean }>(conteudo: T): Omit<T, 'logoBuffet'> {
  const { logoBuffet: _campo, ...resto } = conteudo;
  void _campo;
  return resto;
}

const TIPOS_LOGO = new Set(['image/png', 'image/jpeg', 'image/webp']);
/** Data URL da logo (já preparada pelo Perfil) → bytes e tipo; qualquer outra forma é recusada. */
export function bytesDaLogo(dataUrl: string | null | undefined): { tipo: string; bytes: Buffer } | null {
  const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl ?? '');
  if (!m || !TIPOS_LOGO.has(m[1]!)) return null;
  const bytes = Buffer.from(m[2]!, 'base64');
  return bytes.length ? { tipo: m[1]!, bytes } : null;
}

/**
 * Logo aplicada e padrão do buffet da empresa SaaS, pela mesma ligação empresa ↔ perfil do painel.
 * Tolerante: sem a estrutura do Perfil, sem perfil ou com ligação ambígua, não há logo e o padrão fica ligado.
 */
export async function marcaDoBuffet(executor: DbExecutor, empresaSaasId: string): Promise<MarcaBuffet> {
  const estrutura = (await executor.query<{ ok: boolean }>(`SELECT to_regclass('public.perfil_empresas') IS NOT NULL
    AND to_regclass('public.perfil_empresa_revisoes') IS NOT NULL AS ok`)).rows[0];
  if (!estrutura?.ok) return SEM_MARCA;
  const perfis = (await executor.query<{ id: string }>(`SELECT p.id::text AS id FROM public.perfil_empresas p
    JOIN LATERAL (${EMPRESA_SAAS_DO_PERFIL}) e ON e.candidatos=1 AND e.status='ATIVA' WHERE e.id=$1::uuid`, [empresaSaasId])).rows;
  if (perfis.length !== 1) return SEM_MARCA;
  const linha = (await executor.query<{ logo: string | null; padrao: unknown }>(`SELECT conteudo->>'logoDataUrl' AS logo, conteudo->'logoNosConvites' AS padrao
    FROM public.perfil_empresa_revisoes WHERE empresa_id=$1 AND estado='APLICADA' ORDER BY numero DESC LIMIT 1`, [perfis[0]!.id])).rows[0];
  return { logoDataUrl: bytesDaLogo(linha?.logo) ? linha!.logo : null, padrao: linha?.padrao !== false };
}
