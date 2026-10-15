import { NextResponse } from "next/server";
import { db } from "../../db/postgres.ts";
import { limitarPublico } from "../../http/limite-publico.ts";
import { contatoPublicoDe } from "../../fechamentos/marca-publica.ts";
import { campanhaPorCodigo } from "../campanhas.ts";
import { normalizarHost } from "../dominios/hosts.ts";
import { capturarCampanha, CODIGO_CAMPANHA, destinoComUtm } from "../utm.ts";
import { imagemPublica, registrarClique, sitePublicoPorHost, sitePublicoPorSlug, type SitePublico } from "./publico.ts";
import { origemPlataforma, robotsTxt, sitemapXml, urlCanonica } from "./seo.ts";

/**
 * Respostas públicas do site, iguais para o endereço da plataforma (/s/<site>) e para o domínio personalizado
 * (/sd/<host>, só alcançado pela reescrita do proxy; o Host recebido é conferido aqui). 404 é sempre o mesmo.
 */
export type Via = { tipo: "PLATAFORMA"; slug: string } | { tipo: "DOMINIO"; host: string };

export type PaginaResolvida = {
  site: SitePublico;
  /** Prefixo dos links internos: "/s/<slug>" na plataforma; "" no domínio. */
  base: string;
  /** Origem absoluta de quem serviu (para imagens de compartilhamento). */
  origem: string;
  canonical: string;
  indexavel: boolean;
  /** Apelido (ex.: www) → endereço absoluto do host principal. */
  redirecionarPara: string | null;
};

type Cabecalhos = { get(nome: string): string | null };

/**
 * O caminho /sd/<host> só vale vindo da reescrita do proxy: o Host recebido tem de ser o mesmo do caminho (o proxy
 * recusa /sd/... em qualquer outro Host). Não usa cabeçalho próprio: o Next 16 não o repassa ao destino reescrito.
 */
export function viaDominioConfirmada(hostParam: string, cabecalhos: Cabecalhos): Via | null {
  let host: string | null;
  try { host = normalizarHost(decodeURIComponent(hostParam)); } catch { return null; }
  const recebido = normalizarHost(cabecalhos.get("host")) ?? normalizarHost(cabecalhos.get("x-forwarded-host"));
  if (!host || recebido !== host) return null;
  return { tipo: "DOMINIO", host };
}

/** Porta do Host recebido (só para montar endereços no ambiente local; em produção não há porta). */
function portaDo(hostOriginal: string | null | undefined) {
  const m = /:(\d{1,5})$/.exec(hostOriginal ?? "");
  return m ? `:${m[1]}` : "";
}

export async function resolverPagina(via: Via, env = process.env, hostOriginal: string | null = null): Promise<PaginaResolvida | null> {
  if (via.tipo === "PLATAFORMA") {
    const site = await sitePublicoPorSlug(db(), via.slug, env);
    if (!site) return null;
    const canonical = urlCanonica(site.slug, site.dominioPrincipal, env);
    const aqui = `${origemPlataforma(env)}/s/${site.slug}`;
    return { site, base: `/s/${site.slug}`, origem: origemPlataforma(env), canonical, indexavel: site.conteudo.seo?.indexavel === true && canonical === aqui, redirecionarPara: null };
  }
  const r = await sitePublicoPorHost(db(), via.host, env);
  if (!r) return null;
  const canonical = urlCanonica(r.site.slug, r.site.dominioPrincipal, env);
  const esquema = r.dominio.simulado ? "http" : "https";
  const porta = r.dominio.simulado ? portaDo(hostOriginal) : "";
  return {
    site: r.site, base: "", origem: `${esquema}://${via.host}${porta}`, canonical,
    // Domínio simulado nunca é indexável (não é público de verdade); apelido também não.
    indexavel: r.site.conteudo.seo?.indexavel === true && !r.dominio.simulado && r.dominio.ehPrincipal,
    redirecionarPara: r.dominio.ehPrincipal ? null : `${esquema}://${r.dominio.principalHost}${porta}/`,
  };
}

const NAO_ENCONTRADO = () => new NextResponse("Não encontrado.", { status: 404, headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" } });

function redirecionar(destino: string, status = 302) {
  return new NextResponse(null, { status, headers: { Location: destino, "Cache-Control": "no-store", "Referrer-Policy": "strict-origin-when-cross-origin" } });
}

export async function respostaImagem(via: Via, imagemIdBruto: string) {
  const imagemId = /^[0-9a-f-]{36}$/i.test(imagemIdBruto) ? imagemIdBruto.toLowerCase() : null;
  const pagina = imagemId ? await resolverPagina(via) : null;
  if (!pagina || !imagemId) return NAO_ENCONTRADO();
  const imagem = await imagemPublica(db(), pagina.site, imagemId);
  if (!imagem) return NAO_ENCONTRADO();
  return new NextResponse(new Uint8Array(imagem.conteudo), {
    headers: {
      "Content-Type": "image/webp", "Cache-Control": "public, max-age=300", ETag: `"${imagem.sha256}"`, "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
}

type RequisicaoPublica = { headers: { get(nome: string): string | null }; nextUrl: URL };

/** Link de campanha: registra o clique (evento próprio) e leva à página com UTM e `kc`. Campanha arquivada/desconhecida: página sem UTM. */
export async function respostaCliqueCampanha(via: Via, codigoBruto: string, request: RequisicaoPublica) {
  const pagina = await resolverPagina(via);
  if (!pagina) return NAO_ENCONTRADO();
  const inicio = `${pagina.base}/`;
  const codigo = CODIGO_CAMPANHA.test(codigoBruto) ? codigoBruto : null;
  const campanha = codigo ? await campanhaPorCodigo(db(), pagina.site.empresaId, codigo).catch(() => null) : null;
  if (!campanha) return redirecionar(inicio);
  // Limite por origem: acima dele o redirecionamento continua, mas o clique não é contado (contra inflar números).
  if (!limitarPublico(request, "LEITURA")) await registrarClique(db(), pagina.site, "CLIQUE_LINK_CAMPANHA", campanha.id).catch(() => undefined);
  const destino = destinoComUtm("http://destino.invalid" + pagina.base, campanha);
  return redirecionar(`${destino.pathname}${destino.search}`);
}

/** Botão de WhatsApp: clique registrado separado (não é conversa nem contato) e redirecionamento ao wa.me do buffet. */
export async function respostaWhatsapp(via: Via, request: RequisicaoPublica) {
  const pagina = await resolverPagina(via);
  if (!pagina) return NAO_ENCONTRADO();
  const c = pagina.site.conteudo.contato;
  const contato = c?.botaoWhatsapp ? contatoPublicoDe({ whatsapp: c.whatsapp }) : null;
  if (!contato?.whatsapp) return NAO_ENCONTRADO();
  const captura = capturarCampanha(request.nextUrl.searchParams);
  const campanha = captura.codigoCampanha ? await campanhaPorCodigo(db(), pagina.site.empresaId, captura.codigoCampanha).catch(() => null) : null;
  if (!limitarPublico(request, "LEITURA")) await registrarClique(db(), pagina.site, "CLIQUE_WHATSAPP", campanha?.id ?? null).catch(() => undefined);
  const texto = encodeURIComponent(`Olá! Vi o site do ${pagina.site.conteudo.identidade.nome} e gostaria de um orçamento.`);
  return redirecionar(`${contato.whatsapp.url}?text=${texto}`);
}

export async function respostaSitemap(via: Via) {
  const pagina = await resolverPagina(via);
  if (!pagina) return NAO_ENCONTRADO();
  const entradas = pagina.indexavel ? [{ url: pagina.canonical, atualizadoEm: pagina.site.conteudo.publicadoEm ?? new Date().toISOString() }] : [];
  return new NextResponse(sitemapXml(entradas), { headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=300" } });
}

export async function respostaRobots(via: Via) {
  const pagina = await resolverPagina(via);
  // Host desconhecido também recebe "não indexe" (não revela se existe).
  const corpo = robotsTxt(pagina && pagina.indexavel ? { indexavel: true, sitemap: `${pagina.origem}/sitemap.xml` } : { indexavel: false, sitemap: null });
  return new NextResponse(corpo, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=300" } });
}
