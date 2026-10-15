import type { Metadata } from "next";
import { contatoPublicoDe } from "../../fechamentos/marca-publica.ts";
import type { ConteudoPublicado } from "./conteudo.ts";

/**
 * SEO do site público. Um único canonical por site:
 *   - domínio principal ATIVO e REAL → https://<host>/ (fase futura);
 *   - senão → <origem da plataforma>/s/<slug> (domínio simulado nunca vira canonical).
 * Página servida por domínio simulado ou por apelido é sempre noindex (não cria cópia indexável).
 * Indexação só quando: publicado (a rota já garante) + "permitir buscadores" no conteúdo + página canônica.
 * Dados estruturados (LocalBusiness) só com o que está PUBLICADO; nada de agenda, cliente ou preço não aprovado.
 */
export type AmbienteSeo = { [nome: string]: string | undefined; SITE_URL?: string; ADMIN_AUTH_ORIGIN?: string };

export function origemPlataforma(env: AmbienteSeo = process.env as AmbienteSeo) {
  try {
    const url = new URL(env.SITE_URL || env.ADMIN_AUTH_ORIGIN || "http://localhost:3000");
    if ((url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password) return url.origin;
  } catch { /* abaixo */ }
  return "http://localhost:3000";
}

export function urlCanonica(slug: string, dominioPrincipal: { host: string; simulado: boolean } | null, env: AmbienteSeo = process.env as AmbienteSeo) {
  if (dominioPrincipal && !dominioPrincipal.simulado) return `https://${dominioPrincipal.host}/`;
  return `${origemPlataforma(env)}/s/${slug}`;
}

/** Base dos links internos da página (imagens, campanha, WhatsApp): relativa ao endereço que serviu a página. */
export function baseDaPagina(via: { tipo: "PLATAFORMA"; slug: string } | { tipo: "DOMINIO" }) {
  return via.tipo === "PLATAFORMA" ? `/s/${via.slug}` : "";
}

export function textoTitulo(c: ConteudoPublicado) {
  return (c.seo?.titulo || c.identidade.nome).slice(0, 70);
}
export function textoDescricao(c: ConteudoPublicado) {
  return (c.seo?.descricao || c.apresentacao.texto || c.identidade.slogan || "").replace(/\s+/g, " ").trim().slice(0, 170);
}

export function metadataSite(c: ConteudoPublicado, opcoes: { canonical: string; indexavel: boolean; imagemAbsoluta: string | null }): Metadata {
  const title = textoTitulo(c);
  const description = textoDescricao(c);
  return {
    title: { absolute: title },
    description,
    alternates: { canonical: opcoes.canonical },
    robots: opcoes.indexavel ? { index: true, follow: true } : { index: false, follow: false, nocache: true },
    openGraph: {
      type: "website", locale: "pt_BR", title, description, url: opcoes.canonical, siteName: c.identidade.nome,
      ...(opcoes.imagemAbsoluta ? { images: [{ url: opcoes.imagemAbsoluta, alt: c.identidade.nome }] } : {}),
    },
    twitter: { card: opcoes.imagemAbsoluta ? "summary_large_image" : "summary", title, description },
    icons: { icon: [{ url: "/icone-orcamento.svg", type: "image/svg+xml" }] },
  };
}

/** JSON-LD seguro para <script type="application/ld+json">: `<`, `>` e `&` escapados (sem quebra do script). */
export function jsonLdSeguro(objeto: unknown) {
  return JSON.stringify(objeto).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

export function dadosEstruturados(c: ConteudoPublicado, canonical: string, imagensAbsolutas: string[]) {
  const contato = contatoPublicoDe({ telefone: c.contato.telefone, whatsapp: c.contato.whatsapp, email: c.contato.email, instagram: c.contato.instagram });
  const local = c.localizacao;
  const endereco = local.mostrar && (local.endereco || local.cidade)
    ? { "@type": "PostalAddress", streetAddress: local.endereco || undefined, addressLocality: local.cidade || undefined, addressRegion: local.uf || undefined,
      postalCode: local.cep || undefined, addressCountry: "BR" }
    : undefined;
  return {
    "@context": "https://schema.org",
    "@type": "LocalBusiness",
    name: c.identidade.nome,
    description: textoDescricao(c) || undefined,
    url: canonical,
    ...(imagensAbsolutas.length ? { image: imagensAbsolutas.slice(0, 5) } : {}),
    ...(contato?.telefone ? { telephone: `+55${contato.telefone.url.replace(/\D/g, "").slice(2)}` } : contato?.whatsapp ? { telephone: `+${contato.whatsapp.url.replace(/\D/g, "")}` } : {}),
    ...(endereco ? { address: endereco } : {}),
    ...(contato?.instagram ? { sameAs: [contato.instagram.url] } : {}),
  };
}

function escaparXml(v: string) {
  return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** Sitemap com só a página publicada e indexável (lista vazia quando não indexável). */
export function sitemapXml(entradas: Array<{ url: string; atualizadoEm: string }>) {
  const urls = entradas.map((e) => `  <url><loc>${escaparXml(e.url)}</loc><lastmod>${escaparXml(e.atualizadoEm.slice(0, 10))}</lastmod></url>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}${urls ? "\n" : ""}</urlset>\n`;
}

export function robotsTxt(opcoes: { indexavel: boolean; sitemap: string | null }) {
  return opcoes.indexavel
    ? `User-agent: *\nAllow: /\nDisallow: /c/\nDisallow: /whatsapp\n${opcoes.sitemap ? `Sitemap: ${opcoes.sitemap}\n` : ""}`
    : "User-agent: *\nDisallow: /\n";
}

export function formatarCentavos(centavos: number) {
  return (centavos / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}
