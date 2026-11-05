import { createHash } from "node:crypto";
import { hostsCimd, mcpAtivo, urlsMcp, type AmbienteMcp } from "../mcp/config.ts";
import { CanalOcupado, PrazoDoPedidoVencido } from "../mcp/admissao.ts";
import { LeiturasSimultaneas, lerCorpoLimitado, type LeituraCorpo } from "../mcp/corpo.ts";
import type { BuscaDocumento } from "./cimd.ts";
import { JanelasFixas } from "../mcp/janelas.ts";
import { SchemaMcpAusente } from "./postgres.ts";
import { iniciarAutorizacao, trocarToken, type DependenciasOAuth } from "./servico.ts";

/**
 * Bordas HTTP públicas do OAuth (authorize e token), sem sessão. Revisões de 27/10 (P1-2 / P2-8) e da rodada 2:
 * - canal desligado ⇒ 503 ANTES de ler corpo, aplicar limite ou tocar o banco;
 * - limites EM PROCESSO antes de qualquer trabalho: global por endpoint, por cliente (client_id) e por origem (só o IP
 *   confiável da borda confirmada; nunca cabeçalho livre). Janelas em JanelasFixas: recusa não cria nem zera janela e
 *   janela vigente nunca é desalojada (achado 1 da rodada 2);
 * - teto PERSISTENTE e ATÔMICO de pedidos pendentes por cliente (repositório) e expurgo que drena em lotes;
 * - corpo do token: teto de bytes, PRAZO total de leitura e número máximo de leituras simultâneas (achado 5);
 * - recusas anônimas NÃO gravam no banco. Política de cobertura (A10, achado 6): TODA recusa destas bordas soma 1 num
 *   agregado (código × rótulo do cliente), com conjunto de dimensões limitado; o agregado é descarregado no log no máximo
 *   uma vez por minuto e por um temporizador independente do tráfego (perda máxima: o último minuto se o processo morrer).
 *   Eventos com pessoa/concessão identificada vão para mcp_auditoria. Métodos não atendidos e erro do fluxo do corpo também
 *   são recusas contadas (rodada 3);
 * - prazo TOTAL por pedido (prazoTotalMs) sobre um repositório cujas transações têm prazo e limites de espera no banco; o
 *   expurgo roda fora do caminho da resposta (rodada 3, achado 1).
 */
export { lerCorpoLimitado, type LeituraCorpo };

export const LIMITES_PUBLICOS = Object.freeze({
  authorizePorOrigem: 20,
  authorizePorCliente: 120,
  authorizeGlobal: 300,
  tokenPorOrigem: 60,
  tokenPorCliente: 300,
  tokenGlobal: 600,
  corpoTokenBytes: 8192,
  corpoPrazoMs: 5000,
  leiturasCorpoSimultaneas: 32,
  // Prazo TOTAL desde a chegada do pedido (inclui a leitura do corpo). Nenhuma etapa começa sem caber nele (rodada 4).
  prazoTotalMs: 10_000,
  etapaBancoMaxMs: 3000,
  etapaCimdMaxMs: 5000,
  // Teto de ARMAZENAMENTO (pedido pendente ~0,5 KiB ⇒ ~2,5 MiB por cliente). client_id do ChatGPT/Claude é compartilhado por
  // todos os usuários: um teto baixo viraria negação de serviço para os legítimos (LIM-3).
  pedidosPendentesPorCliente: 5000,
  expurgoIntervaloMs: 60_000,
  // Com o teto global conferido primeiro, cada minuto cria no máximo ~3 × (authorizeGlobal + tokenGlobal) chaves: bem abaixo.
  maxChaves: 10_000,
  dimensoesLog: 200,
});

type Limites = { readonly [K in keyof typeof LIMITES_PUBLICOS]: number };

export class LimitadorPublicoOAuth {
  private readonly janelas: JanelasFixas;
  private readonly contadores = new Map<string, number>();
  readonly leituras: LeiturasSimultaneas;
  private expurgoEmCurso = false;
  private ultimoLog = Number.NEGATIVE_INFINITY;
  private contadas = 0;
  private ultimoExpurgo = 0;
  readonly limites: Limites;
  private readonly relogio: () => number;
  private readonly log: (linha: string) => void;

  constructor(relogio: () => number = () => Date.now(), limites: Limites = LIMITES_PUBLICOS, log: (linha: string) => void = (l) => console.warn(l)) {
    this.relogio = relogio;
    this.limites = limites;
    this.log = log;
    this.janelas = new JanelasFixas(limites.maxChaves);
    this.leituras = new LeiturasSimultaneas(limites.leiturasCorpoSimultaneas);
  }

  /** Consome uma vaga em TODAS as chaves ou em nenhuma. Devolve segundos de espera quando recusa. */
  tentar(chaves: ReadonlyArray<readonly [string, number]>): number | null {
    return this.janelas.admitir(chaves, this.relogio());
  }

  /** Conta uma recusa anônima (sem banco). `cliente` é um rótulo já sanitizado (rotuloCliente). */
  contar(codigo: string, cliente = "-") {
    const cheio = this.contadores.size >= this.limites.dimensoesLog;
    const chave = `${codigo}@${cliente}`;
    // Excedente vai para UMA chave só: o mapa nunca passa de dimensoesLog + 1 entradas.
    const efetiva = cheio && !this.contadores.has(chave) ? "OUTROS" : chave;
    this.contadores.set(efetiva, (this.contadores.get(efetiva) ?? 0) + 1);
    this.contadas += 1;
    if (this.relogio() - this.ultimoLog >= 60_000) this.descarregar();
  }

  /** Emite o agregado pendente (no máximo uma linha por chamada). Chamado por contar e pelo temporizador da composição. */
  descarregar() {
    if (this.contadores.size === 0) return;
    this.ultimoLog = this.relogio();
    const resumo = [...this.contadores.entries()].map(([c, n]) => `${c}=${n}`).join(" ");
    this.contadores.clear();
    this.log(`[Kidmais MCP OAuth] recusas anônimas no último período: ${resumo}`);
  }

  /** Total acumulado de recusas contadas desde o início do processo (não zera no descarregamento). */
  totalContadas() {
    return this.contadas;
  }

  /** Só leitura (testes de cobertura). */
  pendentes(): ReadonlyMap<string, number> {
    return new Map(this.contadores);
  }

  leiturasEmCurso() {
    return this.leituras.quantas();
  }

  /** No máximo um expurgo por instância ao mesmo tempo e por intervalo. */
  expurgoDevido() {
    const agora = this.relogio();
    if (this.expurgoEmCurso || agora - this.ultimoExpurgo < this.limites.expurgoIntervaloMs) return false;
    this.ultimoExpurgo = agora;
    this.expurgoEmCurso = true;
    return true;
  }

  fimExpurgo() {
    this.expurgoEmCurso = false;
  }

  tamanho() {
    return this.janelas.tamanho();
  }
}

export type DependenciasRotasOAuth = {
  oauth: DependenciasOAuth;
  limites: LimitadorPublicoOAuth;
  /** IP confiável da borda (origemConfiavel + chaveDaOrigem); null quando não comprovado. */
  origem(request: Request): string | null;
};

const chaveCliente = (clientId: string) => createHash("sha256").update(clientId).digest("hex").slice(0, 32);

/** Rótulo de log do cliente: host conhecido (allowlist CIMD) ou hash curto; nunca o texto livre enviado. */
export function rotuloCliente(clientId: string, env: AmbienteMcp) {
  if (!clientId) return "-";
  try {
    const host = new URL(clientId).hostname.toLowerCase();
    if (hostsCimd(env).includes(host)) return host;
  } catch {
    // client_id não é URL: cai no hash
  }
  return `h${createHash("sha256").update(clientId).digest("hex").slice(0, 8)}`;
}

function json(status: number, corpo: unknown, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(corpo), { status, headers: { "content-type": "application/json", "cache-control": "no-store", pragma: "no-cache", ...extra } });
}

function pagina(status: number, mensagem: string, extra: Record<string, string> = {}) {
  return new Response(`<!doctype html><meta charset="utf-8"><title>KidMais</title><p>${mensagem.replace(/[<>&"]/g, "")}</p>`, {
    status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'", ...extra },
  });
}

function canalPronto(deps: DependenciasRotasOAuth) {
  return mcpAtivo(deps.oauth.env) && urlsMcp(deps.oauth.env) !== null;
}

/**
 * Rodada 4, achado 3: o prazo total é PROPAGADO às etapas. Antes de cada operação do repositório (prazo próprio ≤ 3 s) e de
 * cada busca CIMD (≤ 5 s), confere se ela ainda cabe até o limite; se não couber, NÃO começa (PrazoDoPedidoVencido). Assim,
 * depois do limite nenhuma etapa nova (pedido, código, refresh, tokens) é iniciada; só a que já estava em voo pode concluir
 * (COMMIT enviado tem resultado incerto, limitação declarada).
 */
function dependenciasComPrazo(oauth: DependenciasOAuth, limite: number, L: Limites, aoVencer: () => void): DependenciasOAuth {
  const caber = (ms: number) => {
    if (Date.now() + ms > limite) {
      aoVencer();
      throw new PrazoDoPedidoVencido();
    }
  };
  const repo = new Proxy(oauth.repo, {
    get(alvo, nome, receptor) {
      const valor = Reflect.get(alvo, nome, receptor);
      if (typeof valor !== "function") return valor;
      return (...args: unknown[]) => {
        caber(L.etapaBancoMaxMs);
        return (valor as (...a: unknown[]) => unknown).apply(alvo, args);
      };
    },
  });
  const buscarCimd: BuscaDocumento = (url) => {
    caber(L.etapaCimdMaxMs);
    return oauth.buscarCimd(url);
  };
  return { ...oauth, repo, buscarCimd };
}

/** Espera o trabalho no máximo `ms`; depois responde "PRAZO" (o trabalho abandonado nunca vira rejeição sem tratamento). */
async function comPrazoTotal<T>(ms: number, trabalho: () => Promise<T>): Promise<T | "PRAZO"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const prazo = new Promise<"PRAZO">((ok) => { timer = setTimeout(() => ok("PRAZO"), ms); });
  const p = trabalho();
  p.catch(() => undefined);
  try {
    return await Promise.race([p, prazo]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Expurgo FORA do caminho da resposta (rodada 3, achado 1): no máximo um por instância e por intervalo, sem await do pedido.
 * Cada DELETE tem prazo próprio no banco e pula linhas travadas (SKIP LOCKED); ver postgres.ts.
 */
function expurgarEmSegundoPlano(deps: DependenciasRotasOAuth) {
  if (!deps.limites.expurgoDevido()) return;
  deps.oauth.repo.expurgarExpirados()
    .catch(() => deps.limites.contar("EXPURGO_FALHOU"))
    .finally(() => deps.limites.fimExpurgo());
}

/**
 * Métodos não atendidos pelas bordas (rodada 3, achado 3): as rotas Next exportam TODOS os métodos para esta função, para
 * que nenhuma recusa saia pelo 405 automático do framework sem entrar no agregado A10.
 */
export function atenderMetodoNaoPermitido(endpoint: "AUTHORIZE" | "TOKEN", permitido: "GET" | "POST", deps: DependenciasRotasOAuth): Response {
  deps.limites.contar(canalPronto(deps) ? `${endpoint}_METODO` : "CANAL_DESLIGADO");
  return json(405, { error: "invalid_request" }, { allow: permitido });
}

export async function atenderAutorizacao(request: Request, deps: DependenciasRotasOAuth): Promise<Response> {
  const chegada = Date.now();
  if (request.method !== "GET" && request.method !== "HEAD") return atenderMetodoNaoPermitido("AUTHORIZE", "GET", deps);
  if (!canalPronto(deps)) {
    deps.limites.contar("CANAL_DESLIGADO");
    return pagina(503, "Conexão com assistentes externos indisponível.");
  }
  const query = new URL(request.url).searchParams;
  const L = deps.limites.limites;
  const origem = deps.origem(request);
  const clientId = (query.get("client_id") ?? "").slice(0, 500);
  const rotulo = rotuloCliente(clientId, deps.oauth.env);
  const contar = (codigo: string) => deps.limites.contar(codigo, rotulo);
  const espera = deps.limites.tentar([
    ["authorize:global", L.authorizeGlobal],
    ["authorize:cliente:" + chaveCliente(clientId), L.authorizePorCliente],
    ...(origem ? [["authorize:origem:" + origem, L.authorizePorOrigem] as const] : []),
  ]);
  if (espera !== null) {
    contar("AUTHORIZE_LIMITE");
    return pagina(429, "Muitas tentativas de conexão. Aguarde um minuto e tente de novo.", { "retry-after": String(espera) });
  }
  expurgarEmSegundoPlano(deps);
  const limite = chegada + L.prazoTotalMs;
  let venceu = false;
  const oauth = dependenciasComPrazo(deps.oauth, limite, L, () => { venceu = true; });
  try {
    const r = await comPrazoTotal(Math.max(0, limite - Date.now()), () => iniciarAutorizacao(query, oauth, { contarAnonimo: (c) => { if (!venceu) contar(c); }, tetoPendentes: L.pedidosPendentesPorCliente }));
    if (r === "PRAZO" || venceu) {
      contar("AUTHORIZE_PRAZO");
      return pagina(503, "Não foi possível iniciar a conexão agora.");
    }
    if (r.tipo === "ERRO") return pagina(r.status, r.mensagem);
    return new Response(null, { status: 302, headers: { location: r.destino, "cache-control": "no-store" } });
  } catch (error) {
    contar(venceu || error instanceof PrazoDoPedidoVencido ? "AUTHORIZE_PRAZO" : error instanceof CanalOcupado ? "AUTHORIZE_OCUPADO" : "AUTHORIZE_FALHA");
    return pagina(503, error instanceof SchemaMcpAusente ? "Conexão com assistentes externos indisponível." : "Não foi possível iniciar a conexão agora.");
  }
}

export async function atenderToken(request: Request, deps: DependenciasRotasOAuth): Promise<Response> {
  const chegada = Date.now();
  if (request.method !== "POST") return atenderMetodoNaoPermitido("TOKEN", "POST", deps);
  if (!canalPronto(deps)) {
    deps.limites.contar("CANAL_DESLIGADO");
    return json(503, { error: "temporarily_unavailable" });
  }
  const L = deps.limites.limites;
  const contarSemCliente = (codigo: string) => deps.limites.contar(codigo);
  const origem = deps.origem(request);
  // Limite global e por origem ANTES de ler o corpo; o por cliente depois (client_id vem no corpo).
  const espera = deps.limites.tentar([["token:global", L.tokenGlobal], ...(origem ? [["token:origem:" + origem, L.tokenPorOrigem] as const] : [])]);
  if (espera !== null) {
    contarSemCliente("TOKEN_LIMITE");
    return json(429, { error: "too_many_requests" }, { "retry-after": String(espera) });
  }
  if (!/^application\/x-www-form-urlencoded\b/i.test(request.headers.get("content-type") ?? "")) {
    contarSemCliente("TOKEN_CONTENT_TYPE");
    return json(415, { error: "invalid_request" });
  }
  if (!deps.limites.leituras.iniciar()) {
    contarSemCliente("TOKEN_LEITURAS_SIMULTANEAS");
    return json(503, { error: "temporarily_unavailable" }, { "retry-after": "1" });
  }
  let leitura: LeituraCorpo;
  try {
    // A leitura do corpo conta no prazo total do pedido.
    leitura = await lerCorpoLimitado(request, L.corpoTokenBytes, Math.max(0, Math.min(L.corpoPrazoMs, chegada + L.prazoTotalMs - Date.now())));
  } finally {
    deps.limites.leituras.terminar();
  }
  if (!leitura.ok) {
    const RESPOSTA = { PRAZO: [408, "TOKEN_CORPO_PRAZO"], GRANDE: [413, "TOKEN_CORPO_GRANDE"], ERRO: [400, "TOKEN_CORPO_ERRO"] } as const;
    const [status, codigo] = RESPOSTA[leitura.motivo];
    contarSemCliente(codigo);
    return json(status, { error: "invalid_request" });
  }
  const form = new URLSearchParams(leitura.texto);
  const clientId = (form.get("client_id") ?? "").slice(0, 500);
  const rotulo = rotuloCliente(clientId, deps.oauth.env);
  const contar = (codigo: string) => deps.limites.contar(codigo, rotulo);
  const porCliente = deps.limites.tentar([["token:cliente:" + chaveCliente(clientId), L.tokenPorCliente]]);
  if (porCliente !== null) {
    contar("TOKEN_LIMITE_CLIENTE");
    return json(429, { error: "too_many_requests" }, { "retry-after": String(porCliente) });
  }
  expurgarEmSegundoPlano(deps);
  const limite = chegada + L.prazoTotalMs;
  let venceu = false;
  const oauth = dependenciasComPrazo(deps.oauth, limite, L, () => { venceu = true; });
  try {
    const r = await comPrazoTotal(Math.max(0, limite - Date.now()), () => trocarToken(form, oauth, { contarAnonimo: (c) => { if (!venceu) contar(c); } }));
    if (r === "PRAZO" || venceu) {
      contar("TOKEN_PRAZO");
      return json(503, { error: "temporarily_unavailable" });
    }
    return json(r.status, r.corpo);
  } catch (error) {
    contar(venceu || error instanceof PrazoDoPedidoVencido ? "TOKEN_PRAZO" : error instanceof CanalOcupado ? "TOKEN_OCUPADO" : "TOKEN_FALHA");
    return json(503, { error: "temporarily_unavailable" });
  }
}
