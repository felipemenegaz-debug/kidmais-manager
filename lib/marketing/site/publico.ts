import type { DbExecutor } from "../../db/contracts.ts";
import { lerEstadoComercial } from "../../assinatura/estado.ts";
import { recursoIncluido } from "../../assinatura/recursos-plano.ts";
import { siteDoHost } from "../dominios/servico.ts";
import type { AmbienteDominios } from "../dominios/hosts.ts";
import { SLUG_SITE, imagensReferenciadas, type ConteudoPublicado } from "./conteudo.ts";

/**
 * Site público: lê SOMENTE a versão publicada. Abre quando TODAS valem:
 *   - MARKETING_SITES_PUBLICOS=true (desligado por padrão; local liga para a demonstração);
 *   - site PUBLICADO com versão; empresa ATIVA; Marketing no plano; situação comercial diferente de BLOQUEADO.
 * Qualquer falha → null (a rota responde 404 igual para "não existe", "rascunho", "despublicado" e "suspenso").
 */
export type AmbientePublico = AmbienteDominios & { MARKETING_SITES_PUBLICOS?: string };

export type SitePublico = {
  siteId: string; empresaId: string; estabelecimentoId: string | null; slug: string; versaoId: string; conteudo: ConteudoPublicado;
  dominioPrincipal: { host: string; simulado: boolean } | null;
};

export function sitesPublicosAtivos(env: AmbientePublico = process.env as AmbientePublico) {
  return env.MARKETING_SITES_PUBLICOS?.trim() === "true";
}

export type DependenciasPublico = { recursoIncluido: typeof recursoIncluido; lerEstadoComercial: typeof lerEstadoComercial };
const PADRAO: DependenciasPublico = { recursoIncluido, lerEstadoComercial };

async function montar(tx: DbExecutor, filtro: { slug?: string; siteId?: string }, deps: DependenciasPublico): Promise<SitePublico | null> {
  const r = await tx.query<{ id: string; empresa_id: string; estabelecimento_id: string | null; slug: string; versao_id: string; conteudo: ConteudoPublicado;
    principal_host: string | null; principal_simulado: boolean | null }>(
    `SELECT s.id::text, s.empresa_id::text, s.estabelecimento_id::text, s.slug, v.id::text AS versao_id, v.conteudo,
            d.host AS principal_host, d.simulado AS principal_simulado
       FROM marketing_sites s
       JOIN marketing_site_versoes v ON v.id = s.versao_publicada_id AND v.site_id = s.id
       JOIN empresas e ON e.id = s.empresa_id AND e.status = 'ATIVA'
       LEFT JOIN marketing_dominios d ON d.site_id = s.id AND d.principal AND d.status = 'ATIVO'
      WHERE s.estado = 'PUBLICADO' AND ($1::text IS NULL OR s.slug = $1) AND ($2::uuid IS NULL OR s.id = $2::uuid)`,
    [filtro.slug ?? null, filtro.siteId ?? null],
  );
  const s = r.rows[0];
  if (!s) return null;
  try {
    if (!(await deps.recursoIncluido(tx, s.empresa_id, "MARKETING"))) return null;
    const { acesso } = await deps.lerEstadoComercial(tx, s.empresa_id);
    if (acesso.nivel === "BLOQUEADO") return null;
  } catch {
    return null;
  }
  return {
    siteId: s.id, empresaId: s.empresa_id, estabelecimentoId: s.estabelecimento_id, slug: s.slug, versaoId: s.versao_id, conteudo: s.conteudo,
    dominioPrincipal: s.principal_host ? { host: s.principal_host, simulado: s.principal_simulado === true } : null,
  };
}

export async function sitePublicoPorSlug(tx: DbExecutor, slug: string, env: AmbientePublico = process.env as AmbientePublico, deps = PADRAO) {
  if (!sitesPublicosAtivos(env) || !SLUG_SITE.test(slug)) return null;
  return montar(tx, { slug }, deps);
}

export async function sitePublicoPorHost(tx: DbExecutor, host: string, env: AmbientePublico = process.env as AmbientePublico, deps = PADRAO) {
  if (!sitesPublicosAtivos(env) || env.MARKETING_DOMINIOS_PERSONALIZADOS?.trim() !== "true") return null;
  const dominio = await siteDoHost(tx, host, env);
  if (!dominio) return null;
  const site = await montar(tx, { siteId: dominio.siteId }, deps);
  return site ? { site, dominio } : null;
}

/** Imagem servida publicamente: do site, não removida e citada na versão PUBLICADA vigente (logo, galeria ou foto de pacote). */
export async function imagemPublica(tx: DbExecutor, site: SitePublico, imagemId: string) {
  const citadas = imagensReferenciadas(site.conteudo);
  if (!citadas.includes(imagemId)) return null;
  const r = await tx.query<{ conteudo: Buffer; sha256: string }>(
    `SELECT conteudo, sha256 FROM marketing_site_imagens WHERE id = $1::uuid AND site_id = $2::uuid AND empresa_id = $3::uuid AND removida_em IS NULL`,
    [imagemId, site.siteId, site.empresaId],
  );
  return r.rows[0] ?? null;
}

/** Registro de clique (sem IP nem dado pessoal). Falha ao registrar nunca impede o redirecionamento. */
export async function registrarClique(tx: DbExecutor, site: SitePublico, tipo: "CLIQUE_LINK_CAMPANHA" | "CLIQUE_WHATSAPP", campanhaId: string | null) {
  await tx.query(
    `INSERT INTO marketing_eventos (empresa_id, site_id, campanha_id, tipo) VALUES ($1::uuid, $2::uuid, $3::uuid, $4)`,
    [site.empresaId, site.siteId, campanhaId, tipo],
  );
}
