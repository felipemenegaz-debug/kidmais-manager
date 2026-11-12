/**
 * Endereços do fluxo público. Sem empresa: os atuais (/fechamento, /disponibilidade, /api/...), configurados no servidor.
 * Com empresa: /b/<código>/... e `?empresa=<código>` nas APIs. O código só escolhe o buffet público; quem decide se ele
 * atende (status, plano, situação comercial) é o servidor (lib/comercial/cotacao-publica.ts).
 */
export function apiPublica(caminho: string, empresa?: string | null) {
  if (!empresa) return caminho;
  return `${caminho}${caminho.includes("?") ? "&" : "?"}empresa=${encodeURIComponent(empresa)}`;
}

/**
 * Páginas do fluxo público. `/orcamento` é o nome do pedido de orçamento no endereço do buffet (/b/<código>/orcamento);
 * sem empresa, o endereço atual continua /fechamento. /b/<código>/fechamento segue respondendo, com a mesma tela, para
 * os links já enviados.
 */
export type PaginaPublica = "/fechamento" | "/orcamento" | "/disponibilidade" | "/saloes";

export function paginaPublica(caminho: PaginaPublica, empresa?: string | null) {
  if (!empresa) return caminho === "/orcamento" ? "/fechamento" : caminho;
  return `/b/${encodeURIComponent(empresa)}${caminho}`;
}

/** Página inicial do buffet: /b/<código>. */
export function paginaInicialPublica(empresa: string) {
  return `/b/${encodeURIComponent(empresa)}`;
}

const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Formato de empresas.codigo (CHECK empresas_codigo_ck da migration 031; o mesmo de CODIGO_EMPRESA_PUBLICA em
 * lib/http/empresas-publicas.ts, conferido por teste). Repetido aqui porque este arquivo também vai para o navegador.
 */
const CODIGO_EMPRESA = /^[a-z][a-z0-9-]{1,62}[a-z0-9]$/;

/**
 * Endereço absoluto de uma página pública do buffet (para copiar ou enviar), na origem do produto
 * (ex.: https://iafest.demerzellabs.com.br). A origem vem da configuração do servidor, nunca do pedido.
 * Código fora do formato de empresas.codigo (vazio, "..", maiúsculas, barra), origem inválida, com caminho, credencial
 * ou http fora da máquina local: null (melhor sem link do que um link para outra página ou para o fluxo sem empresa).
 */
export function enderecoPublicoAbsoluto(origem: string | null | undefined, empresa: string, caminho?: PaginaPublica) {
  if (typeof empresa !== "string" || !CODIGO_EMPRESA.test(empresa)) return null;
  let u: URL;
  try { u = new URL((origem ?? "").trim()); } catch { return null; }
  if (u.pathname !== "/" || u.search || u.hash || u.username || u.password) return null;
  const seguro = u.protocol === "https:" || (u.protocol === "http:" && LOCAL.has(u.hostname));
  if (!seguro) return null;
  return `${u.origin}${caminho ? paginaPublica(caminho, empresa) : paginaInicialPublica(empresa)}`;
}
