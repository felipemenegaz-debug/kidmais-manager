/**
 * Host e roteamento de domínio personalizado. Puro (sem banco): usado pelo proxy.ts e pelos testes.
 *
 * Desligado por padrão: só com MARKETING_DOMINIOS_PERSONALIZADOS=true o proxy olha o Host. Assim um deploy sem a
 * configuração nunca desvia o painel administrativo. Hosts da plataforma (painel, site de venda, convites) são sempre
 * servidos como hoje; qualquer outro Host válido vai para /sd/<host>/..., que só responde se o host estiver ATIVO no
 * banco (e, se simulado, só com MARKETING_DOMINIO_SIMULADO_SERVIR=true). Host inválido ou desconhecido = 404, sem
 * revelar se o domínio existe.
 */
export type AmbienteDominios = {
  [nome: string]: string | undefined;
  MARKETING_DOMINIOS_PERSONALIZADOS?: string;
  MARKETING_HOSTS_PLATAFORMA?: string;
  MARKETING_DOMINIO_SIMULADO_SERVIR?: string;
  ADMIN_AUTH_ORIGIN?: string;
  SITE_URL?: string;
  CONVITES_PUBLIC_ORIGIN?: string;
};

export const HOST_VALIDO = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

/** Host do cabeçalho: minúsculo, sem porta e sem ponto final. Lista, credencial, IP ou formato inválido = null. */
export function normalizarHost(valor: string | null | undefined): string | null {
  if (!valor) return null;
  const bruto = valor.trim().toLowerCase();
  if (!bruto || bruto.includes(",") || bruto.includes("@") || bruto.includes("/") || bruto.startsWith("[")) return null;
  const semPorta = bruto.replace(/:\d{1,5}$/, "").replace(/\.$/, "");
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(semPorta)) return null;
  return HOST_VALIDO.test(semPorta) ? semPorta : null;
}

function hostDeOrigem(origem: string | undefined) {
  if (!origem) return null;
  try { return new URL(origem).hostname.toLowerCase(); } catch { return null; }
}

export function hostsDaPlataforma(env: AmbienteDominios) {
  const hosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
  for (const h of (env.MARKETING_HOSTS_PLATAFORMA ?? "").split(",").map((v) => v.trim().toLowerCase()).filter(Boolean)) hosts.add(h.replace(/:\d+$/, ""));
  for (const o of [env.ADMIN_AUTH_ORIGIN, env.SITE_URL, env.CONVITES_PUBLIC_ORIGIN]) { const h = hostDeOrigem(o); if (h) hosts.add(h); }
  return hosts;
}

/** O host pertence à plataforma (ou é subdomínio de um host da plataforma): nunca pode ser cadastrado por empresa. */
export function hostReservado(host: string, env: AmbienteDominios) {
  for (const p of hostsDaPlataforma(env)) if (host === p || host.endsWith(`.${p}`)) return true;
  return /(^|\.)(onrender\.com|kidmais\.com\.br|kidmaisfestas\.com|kidmaisfestas\.com\.br)$/.test(host);
}

export function dominiosPersonalizadosAtivos(env: AmbienteDominios) {
  return env.MARKETING_DOMINIOS_PERSONALIZADOS?.trim() === "true";
}

export function servirDominioSimulado(env: AmbienteDominios) {
  return env.MARKETING_DOMINIO_SIMULADO_SERVIR?.trim() === "true";
}

/** Caminhos que um domínio personalizado atende; o resto vira 404 (painel e APIs internas nunca abrem por ele). */
export function caminhoNoDominio(pathname: string): string | null {
  if (pathname === "/" || pathname === "") return "";
  if (pathname === "/robots.txt" || pathname === "/sitemap.xml" || pathname === "/whatsapp") return pathname;
  if (/^\/imagens\/[0-9a-f-]{36}$/i.test(pathname)) return pathname.toLowerCase();
  if (/^\/c\/[a-z0-9][a-z0-9-]{2,46}[a-z0-9]$/.test(pathname)) return pathname;
  return null;
}

export type Roteamento =
  | { tipo: "PLATAFORMA" }
  | { tipo: "PASSAR" }
  | { tipo: "DOMINIO"; host: string; destino: string };

/**
 * Decisão do proxy. `PASSAR`: arquivos do Next e a API pública do formulário seguem sem reescrita mesmo no domínio
 * (a API resolve o site pelo endereço, nunca pelo Host).
 */
export function rotear(hostCabecalho: string | null, pathname: string, env: AmbienteDominios): Roteamento {
  const rota = rotearHost(hostCabecalho, pathname, env);
  // /sd/... é destino interno da reescrita: pedido direto (em qualquer Host, ligado ou não) é sempre 404.
  if (rota.tipo !== "DOMINIO" && (pathname === "/sd" || pathname.startsWith("/sd/"))) return { tipo: "DOMINIO", host: "host-invalido.invalid", destino: "/sd/host-invalido.invalid/404" };
  return rota;
}

function rotearHost(hostCabecalho: string | null, pathname: string, env: AmbienteDominios): Roteamento {
  if (!dominiosPersonalizadosAtivos(env)) return { tipo: "PLATAFORMA" };
  const bruto = (hostCabecalho ?? "").trim().toLowerCase().replace(/:\d{1,5}$/, "");
  if (hostsDaPlataforma(env).has(bruto)) return { tipo: "PLATAFORMA" };
  const host = normalizarHost(hostCabecalho);
  if (!host) return { tipo: "DOMINIO", host: "host-invalido.invalid", destino: "/sd/host-invalido.invalid/404" };
  if (hostReservado(host, env)) return { tipo: "PLATAFORMA" };
  if (pathname.startsWith("/_next/") || pathname === "/favicon.ico" || /^\/api\/publico\/marketing\/[a-z0-9-]+\/contato$/.test(pathname)) return { tipo: "PASSAR" };
  const resto = caminhoNoDominio(pathname);
  return { tipo: "DOMINIO", host, destino: resto === null ? `/sd/${host}/404` : `/sd/${host}${resto}` };
}

/** Instruções de DNS (o cliente aplica no provedor dele; nada é alterado automaticamente). */
export function instrucoesDns(host: string, token: string, alvo: { cname: string; ip: string }) {
  const partes = host.split(".");
  const ehRaiz = partes.length === 2 || (partes.length === 3 && /^(com|net|org|art|blog|edu|gov|eco|emp)\.br$/.test(partes.slice(1).join(".")));
  return {
    verificacao: { tipo: "TXT" as const, nome: `_kidmais-verificacao.${host}`, valor: `kidmais-verificacao=${token}` },
    apontamento: ehRaiz
      ? { tipo: "A" as const, nome: host, valor: alvo.ip, observacao: "Domínio raiz: use registro A (ou ALIAS/ANAME, se o provedor oferecer) para o endereço indicado." }
      : { tipo: "CNAME" as const, nome: host, valor: alvo.cname, observacao: "Subdomínio: use CNAME para o endereço indicado." },
    ehRaiz,
  };
}

export function alvoDns(env: { MARKETING_DOMINIO_ALVO_CNAME?: string; MARKETING_DOMINIO_ALVO_IP?: string }) {
  return {
    // Valores de demonstração (RFC 2606 / RFC 5737): nunca apontam para infraestrutura real.
    cname: env.MARKETING_DOMINIO_ALVO_CNAME?.trim() || "sites.kidmais-demo.invalid",
    ip: env.MARKETING_DOMINIO_ALVO_IP?.trim() || "192.0.2.10",
  };
}
