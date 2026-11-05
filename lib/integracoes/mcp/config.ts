/**
 * Configuração do canal MCP externo (docs/MCP_ASSINATURAS_V1.md). Único lugar que lê as variáveis do canal.
 *
 * Tudo falha fechado: só o texto exato "true" liga, URL fora de HTTPS (exceto loopback fora de produção) desliga, segredo
 * curto desliga a parte que depende dele. O canal NÃO substitui as guardas da Inteligência: a chave-mestra, o grupo READ e a
 * allowlist por empresa (lib/inteligencia/flags.ts) continuam valendo em cada chamada de ferramenta (gateway canônico).
 *
 * - MCP_ENABLED: chave do canal. Desligada, /api/mcp responde 503 antes de autenticar ou abrir banco.
 * - MCP_TENANT_ALLOWLIST: empresas (uuid, vírgula) do piloto. OBRIGATÓRIA: ausente, vazia ou inválida ⇒ nenhuma empresa.
 * - MCP_PUBLIC_URL: URL do recurso MCP (ex.: https://manager.kidmaisfestas.com/api/mcp). É o `resource`/audience.
 * - MCP_CIMD_HOSTS: hosts aceitos como Client ID Metadata Document (padrão: chatgpt.com, claude.ai).
 * - MCP_REF_SECRET: segredo (≥ 32) das referências opacas de conhecimento. Ausente ⇒ busca e trecho indisponíveis.
 */
export type AmbienteMcp = Readonly<Record<string, string | undefined>>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** Prazos e limites documentados (não são promessa aos clientes; cada fabricante renova conforme o próprio cliente). */
export const PRAZOS_MCP = Object.freeze({
  pedidoAutorizacaoS: 600,
  codigoS: 60,
  acessoS: 3600,
  atualizacaoS: 30 * 86_400,
  clienteCimdCacheS: 3600,
});

export const LIMITES_MCP = Object.freeze({
  corpoBytes: 64 * 1024,
  // Corpo do /api/mcp lido por inteiro, com prazo total, ANTES de ocupar a vaga da concessão (rodada 3, achado 4).
  corpoPrazoMs: 5000,
  leiturasCorpoSimultaneas: 32,
  chamadasPorMinutoPorConcessao: 30,
  chamadasPorMinutoPorEmpresa: 120,
  concorrenciaPorConcessao: 2,
  // Rodada 4, achados 1 e 2: uma concessão/empresa não monopoliza recursos globais; autenticação admitida ANTES do banco.
  concorrenciaPorEmpresa: 4,
  autenticacoesPorMinuto: 1200,
  autenticacoesPorOrigemPorMinuto: 120,
  autenticacoesSimultaneas: 8,
  prazoFerramentaMs: 5000,
  consultaConhecimentoMax: 500,
  resultadosPadrao: 5,
  resultadosMax: 10,
  trechoMaxCaracteres: 1200,
  referenciaValidadeS: 86_400,
  // Acima disto o resumo financeiro recusa (VOLUME_ACIMA_DO_LIMITE) sem materializar a lista; ver docs §15.
  recebiveisMax: 5000,
});

export const ESCOPOS_MCP = ["agenda:read", "financeiro:read", "conhecimento:read"] as const;
export type EscopoMcp = (typeof ESCOPOS_MCP)[number];

export function escopoValido(valor: string): valor is EscopoMcp {
  return (ESCOPOS_MCP as readonly string[]).includes(valor);
}

export function mcpAtivo(env: AmbienteMcp) {
  return env.MCP_ENABLED === "true";
}

/** Allowlist obrigatória do piloto: sem lista válida, nenhuma empresa usa o canal. */
export function empresaNoPilotoMcp(env: AmbienteMcp, empresaId: string) {
  const bruto = env.MCP_TENANT_ALLOWLIST;
  if (bruto === undefined || bruto.trim() === "") return false;
  const lista = bruto.split(",").map((valor) => valor.trim().toLowerCase());
  if (lista.some((valor) => !UUID.test(valor))) return false;
  return lista.includes(empresaId.toLowerCase());
}

function loopback(host: string) {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

export type UrlsMcp = { recurso: string; emissor: string; origem: string; metadadosRecurso: string };

/**
 * URL pública do recurso. HTTPS obrigatório; http só em loopback fora de produção (testes locais).
 * Sem query nem fragmento. O emissor (issuer) é a origem da mesma URL: o servidor de autorização é a própria aplicação.
 */
export function urlsMcp(env: AmbienteMcp): UrlsMcp | null {
  const bruto = env.MCP_PUBLIC_URL;
  if (!bruto) return null;
  let url: URL;
  try {
    url = new URL(bruto);
  } catch {
    return null;
  }
  if (url.search || url.hash || url.username || url.password) return null;
  const local = env.NODE_ENV !== "production" && url.protocol === "http:" && loopback(url.hostname);
  if (url.protocol !== "https:" && !local) return null;
  const recurso = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  return {
    recurso,
    emissor: url.origin,
    origem: url.origin,
    metadadosRecurso: `${url.origin}/.well-known/oauth-protected-resource${url.pathname.replace(/\/+$/, "")}`,
  };
}

export function hostsCimd(env: AmbienteMcp): readonly string[] {
  const bruto = env.MCP_CIMD_HOSTS;
  const lista = (bruto === undefined ? "chatgpt.com,claude.ai" : bruto).split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  return lista.every((h) => HOST.test(h)) ? lista : [];
}

export function segredoReferencias(env: AmbienteMcp): string | null {
  const s = env.MCP_REF_SECRET;
  return s && s.length >= 32 ? s : null;
}
