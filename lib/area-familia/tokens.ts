import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Área "Minha festa" (123): segredos e cookie. Só o SHA-256 do link e do cookie vai ao banco; o documento do segundo
 * responsável, quando informado, vira HMAC com o pepper da identidade (CPF tem pouca entropia: SHA-256 puro seria
 * reversível por força bruta).
 */
export const CODIGO_EMPRESA_AREA = /^[a-z][a-z0-9-]{1,62}[a-z0-9]$/;
/** 32 bytes em base64url (43 caracteres, sem preenchimento). */
export const FORMATO_TOKEN_AREA = /^[A-Za-z0-9_-]{43}$/;

export const SESSAO_SEM_LEMBRAR_MS = 12 * 60 * 60 * 1000;
export const SESSAO_LEMBRAR_MS = 30 * 24 * 60 * 60 * 1000;

export function gerarTokenArea() {
  return randomBytes(32).toString("base64url");
}

export function hashTokenArea(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

/** Forma canônica do documento: só letras e dígitos, em maiúsculas. CPF fica só com dígitos; CNPJ alfanumérico mantém as letras. */
export function documentoCanonico(documento: string | null | undefined) {
  return (documento ?? "").replace(/[^0-9A-Za-z]/g, "").toUpperCase();
}

export function hashDocumentoPessoa(documento: string, pepper: string) {
  return createHmac("sha256", pepper).update("area-familia:documento|").update(documentoCanonico(documento)).digest("hex");
}

/**
 * HMAC do código da área, amarrado ao destino para onde foi enviado (AF-R1): se o WhatsApp mudar depois do envio, o
 * código antigo deixa de conferir mesmo que algum caminho deixe a validação pendente.
 */
export function hashCodigoArea(codigo: string, pepper: string, ctx: { clienteId: string; destino: string; codigoExpiraEm: string }) {
  return createHmac("sha256", pepper)
    .update("area-familia:codigo|").update(ctx.clienteId).update("|")
    .update(ctx.destino.replace(/[^0-9]/g, "")).update("|")
    .update(new Date(ctx.codigoExpiraEm).toISOString()).update("|")
    .update(codigo)
    .digest("hex");
}

export function hashesIguais(a: string, b: string) {
  if (!/^[a-f0-9]{64}$/i.test(a) || !/^[a-f0-9]{64}$/i.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

/** Um cookie por empresa: duas áreas de buffets diferentes no mesmo navegador não se misturam. */
export function nomeCookieArea(codigo: string) {
  if (!CODIGO_EMPRESA_AREA.test(codigo)) throw new Error("CODIGO_EMPRESA_INVALIDO");
  return `__Secure-kmaf-${codigo}`;
}

export function caminhoArea(codigo: string) {
  if (!CODIGO_EMPRESA_AREA.test(codigo)) throw new Error("CODIGO_EMPRESA_INVALIDO");
  return `/b/${codigo}/minha-festa`;
}

export type CookieArea = {
  name: string;
  value: string;
  httpOnly: true;
  secure: true;
  sameSite: "lax";
  path: string;
  expires?: Date;
};

/**
 * Sem "lembrar": cookie de sessão do navegador (o servidor corta em 12 h). Com "lembrar": expira junto com a sessão.
 * O caminho restringe o envio à área desta empresa (página e APIs ficam debaixo dele).
 */
export function cookieDaSessao(codigo: string, token: string, lembrar: boolean, expiraEm: Date): CookieArea {
  const base = { name: nomeCookieArea(codigo), value: token, httpOnly: true, secure: true, sameSite: "lax", path: caminhoArea(codigo) } as const;
  return lembrar ? { ...base, expires: expiraEm } : { ...base };
}

export function cookieApagado(codigo: string): CookieArea {
  return { name: nomeCookieArea(codigo), value: "", httpOnly: true, secure: true, sameSite: "lax", path: caminhoArea(codigo), expires: new Date(0) };
}

/** Rótulo curto do aparelho para a lista do buffet: nunca o user-agent inteiro. */
export function rotuloAparelho(userAgent: string | null) {
  const ua = userAgent ?? "";
  const sistema = /iPhone|iPad/.test(ua) ? "iPhone/iPad" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows"
    : /Mac OS X/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux" : null;
  const navegador = /Edg\//.test(ua) ? "Edge" : /SamsungBrowser/.test(ua) ? "Samsung Internet" : /Chrome\//.test(ua) ? "Chrome"
    : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : null;
  if (!sistema && !navegador) return null;
  return [navegador, sistema].filter(Boolean).join(" no ").slice(0, 80);
}
