/**
 * Fragmento do link público (`/p/satisfacao#<token>` ou `#<token>.n<0–10>`, pré-marcação do e-mail). Lido só pelo
 * navegador: o fragmento não chega ao servidor (log HTTP, Referer, telemetria). A nota pré-marcada vai em campo próprio
 * no POST e NUNCA entra no token nem no identificador do limite de tentativas. Sem dependência de Node (página cliente).
 */
export function lerFragmento(hash: string): { token: string | null; preMarcada: number | null } {
  const bruto = hash.startsWith("#") ? hash.slice(1) : hash;
  const m = /^([A-Za-z0-9_-]{72})(?:\.n(10|[0-9]))?$/.exec(bruto);
  if (!m) return { token: null, preMarcada: null };
  return { token: m[1], preMarcada: m[2] === undefined ? null : Number(m[2]) };
}

/** Link enviado ao cliente (montado só em memória, na hora do transporte). */
export function linkDaPesquisa(origem: string, token: string, preMarcada?: number) {
  return `${origem.replace(/\/+$/, "")}/p/satisfacao#${token}${preMarcada === undefined ? "" : `.n${preMarcada}`}`;
}

/** Marcador gravado no conteúdo das entregas e caixas de saída no lugar do link (o token nunca é gravado). */
export const MARCADOR_LINK = "[link da pesquisa]";
