/**
 * Endereços do fluxo público. Sem empresa: os atuais (/fechamento, /disponibilidade, /api/...), configurados no servidor.
 * Com empresa: /b/<código>/... e `?empresa=<código>` nas APIs. O código só escolhe o buffet público; quem decide se ele
 * atende (status, plano, situação comercial) é o servidor (lib/comercial/cotacao-publica.ts).
 */
export function apiPublica(caminho: string, empresa?: string | null) {
  if (!empresa) return caminho;
  return `${caminho}${caminho.includes("?") ? "&" : "?"}empresa=${encodeURIComponent(empresa)}`;
}

export function paginaPublica(caminho: "/fechamento" | "/disponibilidade", empresa?: string | null) {
  return empresa ? `/b/${encodeURIComponent(empresa)}${caminho}` : caminho;
}
