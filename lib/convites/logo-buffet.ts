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

type CamposLogo = { logoBuffet?: boolean; logoPosicoes?: unknown; logoOrdem?: unknown; logoGeracoes?: unknown; logoSemNome?: unknown };

/**
 * Etapa 3: chaves que vivem só no rascunho e nunca saem do servidor como estão (a exportação também as retira).
 * `logoSemNome` vai ao buffet (aviso do §4), mas nunca ao publicado nem à família.
 */
export const CHAVES_SO_RASCUNHO = ['logoOrdem', 'logoGeracoes', 'logoSemNome'] as const;

function sem<T extends object>(conteudo: T, chaves: readonly string[]): T {
  const r = { ...conteudo } as Record<string, unknown>;
  for (const k of chaves) delete r[k];
  return r as T;
}

/**
 * O valor gravado prevalece sobre o enviado pela tela (`logoBuffet` e o mapa `logoPosicoes`); sem valor gravado,
 * o campo fica ausente (= ligado / faixa). As chaves só do rascunho que vierem da tela também são descartadas.
 */
export function preservarLogoBuffet<T extends CamposLogo>(novo: T, gravado: CamposLogo | null | undefined): T {
  const resto = sem(novo, ['logoBuffet', 'logoPosicoes', ...CHAVES_SO_RASCUNHO]) as Record<string, unknown>;
  if (typeof gravado?.logoBuffet === 'boolean') resto.logoBuffet = gravado.logoBuffet;
  if (gravado?.logoPosicoes && typeof gravado.logoPosicoes === 'object') resto.logoPosicoes = gravado.logoPosicoes;
  return resto as T;
}

/**
 * salvar/publicar: monta as duas colunas a partir do conteúdo já preservado. O rascunho recupera do gravado as
 * chaves só do rascunho (se existirem); o publicado nunca as tem. Dois JSONs, dois parâmetros.
 */
export function colunasDoConteudo<T extends CamposLogo>(conteudo: T, rascunhoGravado: CamposLogo | null | undefined): { rascunho: T; publicado: T } {
  const publicado = sem(conteudo, CHAVES_SO_RASCUNHO);
  const rascunho = { ...publicado } as Record<string, unknown>;
  for (const k of CHAVES_SO_RASCUNHO) if (rascunhoGravado?.[k] !== undefined) rascunho[k] = rascunhoGravado[k];
  return { rascunho: rascunho as T, publicado };
}

/** Leitura do buffet: recebe `logoPosicoes` e `logoSemNome`; nunca `logoOrdem` nem `logoGeracoes`. */
export function paraBuffet<T extends CamposLogo>(conteudo: T): Omit<T, 'logoOrdem' | 'logoGeracoes'> {
  return sem(conteudo, ['logoOrdem', 'logoGeracoes']);
}

/** A família não recebe nenhum campo da logo: o controle é só do buffet. */
export function semLogoBuffet<T extends CamposLogo>(conteudo: T): Omit<T, 'logoBuffet' | 'logoPosicoes' | 'logoOrdem' | 'logoGeracoes' | 'logoSemNome'> {
  return sem(conteudo, ['logoBuffet', 'logoPosicoes', ...CHAVES_SO_RASCUNHO]);
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
