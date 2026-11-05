import OAuth2Server from "@node-oauth/oauth2-server";
import type { DbExecutor } from "../../db/contracts.ts";
import { agendaDoDia } from "../../inteligencia/leituras/agenda-do-dia.ts";
import { decidirPolitica } from "../../inteligencia/politica-v1.ts";
import { manifestoLeitura } from "../../inteligencia/registro-ferramentas.ts";
import type { SessaoParaTenant, TenantComprovado } from "../../saas/provar-tenant.ts";
import { ESCOPOS_MCP, PRAZOS_MCP, empresaNoPilotoMcp, escopoValido, hostsCimd, mcpAtivo, urlsMcp, type AmbienteMcp, type EscopoMcp, type UrlsMcp } from "../mcp/config.ts";
import { CimdRecusado, carregarClienteCimd, type BuscaDocumento } from "./cimd.ts";
import { RETENCAO_OAUTH, hashSegredo, novoSegredo, type AcessoVerificado, type ClienteOAuth, type RepositorioOAuth } from "./repositorio.ts";

/**
 * Servidor de autorização OAuth 2.1 do canal MCP (docs/MCP_ASSINATURAS_V1.md).
 *
 * Biblioteca: @node-oauth/oauth2-server (fixada) faz a mecânica de authorization_code + PKCE S256 + refresh rotativo;
 * este módulo cuida do que é do KidMais: registro por CIMD, `resource` (RFC 8707), escopos, pedido pendente persistido,
 * consentimento na sessão autenticada, `iss` na resposta (RFC 9207) e modelo persistente com detecção de reuso.
 *
 * Nunca há fallback sem autenticação nem token de administrador: qualquer falha de configuração responde indisponível.
 */
export type DependenciasOAuth = {
  env: AmbienteMcp;
  repo: RepositorioOAuth;
  buscarCimd: BuscaDocumento;
  agora(): Date;
};

export type DependenciasConsentimento = DependenciasOAuth & {
  withTenantTransaction<T>(sessao: SessaoParaTenant, empresaSolicitada: string, work: (tx: DbExecutor, tenant: TenantComprovado) => Promise<T>): Promise<T>;
  leituraComercialPermitida(tx: DbExecutor, empresaId: string): Promise<boolean>;
};

type UsuarioOAuth = { usuarioId: string; empresaId: string; recurso: string; concessaoId?: string; tokenId?: string };

const GRANTS = ["authorization_code", "refresh_token"];
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

export class ErroOAuth extends Error {
  readonly status: number;
  readonly codigo: string;
  constructor(status: number, codigo: string, mensagem: string) {
    super(mensagem);
    this.status = status;
    this.codigo = codigo;
    this.name = "ErroOAuth";
  }
}

const indisponivel = () => new ErroOAuth(503, "temporarily_unavailable", "Conexão com assistentes externos indisponível.");

function exigirUrls(env: AmbienteMcp): UrlsMcp {
  if (!mcpAtivo(env)) throw indisponivel();
  const urls = urlsMcp(env);
  if (!urls) throw indisponivel();
  return urls;
}

// ---------------------------------------------------------------- metadados (RFC 9728 e RFC 8414)

export function metadadosRecurso(env: AmbienteMcp) {
  const urls = exigirUrls(env);
  return {
    resource: urls.recurso,
    authorization_servers: [urls.emissor],
    scopes_supported: [...ESCOPOS_MCP],
    bearer_methods_supported: ["header"],
    resource_name: "KidMais Manager",
  };
}

export function metadadosServidor(env: AmbienteMcp) {
  const urls = exigirUrls(env);
  return {
    issuer: urls.emissor,
    authorization_endpoint: `${urls.emissor}/api/mcp/oauth/authorize`,
    token_endpoint: `${urls.emissor}/api/mcp/oauth/token`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: GRANTS,
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [...ESCOPOS_MCP],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  };
}

/** Desafio do 401 (Claude exige 401; ChatGPT lê `resource_metadata`). */
export function desafioBearer(env: AmbienteMcp, extra?: { erro?: string; escopo?: EscopoMcp }) {
  const urls = urlsMcp(env);
  const partes = [urls ? `resource_metadata="${urls.metadadosRecurso}"` : null, extra?.erro ? `error="${extra.erro}"` : null, `scope="${extra?.escopo ?? ESCOPOS_MCP.join(" ")}"`];
  return `Bearer ${partes.filter(Boolean).join(", ")}`;
}

// ---------------------------------------------------------------- clientes (CIMD com cache persistido)

async function obterCliente(clientId: string, deps: DependenciasOAuth): Promise<ClienteOAuth> {
  const emCache = await deps.repo.clienteEmCache(clientId);
  if (emCache && emCache.validoAte > deps.agora()) return emCache;
  const novo = await carregarClienteCimd(clientId, hostsCimd(deps.env), deps.buscarCimd, deps.agora(), PRAZOS_MCP.clienteCimdCacheS);
  await deps.repo.guardarCliente(novo);
  return novo;
}

// ---------------------------------------------------------------- modelo persistente para a biblioteca

function modelo(deps: DependenciasOAuth, auditar: (codigo: string, concessaoId: string) => Promise<void>) {
  const cliente = (c: ClienteOAuth) => ({ id: c.clientId, nome: c.nome, redirectUris: [...c.redirectUris], grants: GRANTS });
  const reuso = async (concessaoId: string, codigo: string) => {
    await deps.repo.revogarConcessao(concessaoId, "REUSO", null);
    await auditar(codigo, concessaoId);
  };
  return {
    async getClient(clientId: string) {
      try {
        return cliente(await obterCliente(clientId, deps));
      } catch (error) {
        // Recusa definitiva ⇒ cliente desconhecido (invalid_client); transitória sobe como indisponibilidade (503).
        if (error instanceof CimdRecusado && !error.transitorio) return null;
        throw error;
      }
    },
    async validateRedirectUri(redirectUri: string, client: { redirectUris?: string | string[] }) {
      return Array.isArray(client.redirectUris) && client.redirectUris.includes(redirectUri);
    },
    async validateScope(_user: unknown, _client: unknown, scope?: string[]) {
      if (!scope || scope.length === 0 || !scope.every(escopoValido)) return false;
      return [...new Set(scope)];
    },
    async generateAuthorizationCode() {
      return novoSegredo("kmc");
    },
    async generateAccessToken() {
      return novoSegredo("kma");
    },
    async generateRefreshToken() {
      return novoSegredo("kmr");
    },
    async saveAuthorizationCode(code: { authorizationCode: string; expiresAt: Date; redirectUri: string; scope?: string[]; codeChallenge?: string; codeChallengeMethod?: string }, client: { id: string; nome?: string }, user: UsuarioOAuth) {
      if (!code.codeChallenge || code.codeChallengeMethod !== "S256") return null;
      const concessaoId = await deps.repo.criarConcessaoComCodigo({
        usuarioId: user.usuarioId, empresaId: user.empresaId, clientId: client.id, clienteNome: client.nome ?? client.id,
        redirectUri: code.redirectUri, escopos: (code.scope ?? []).filter(escopoValido), recurso: user.recurso,
      }, hashSegredo(code.authorizationCode), code.expiresAt, code.codeChallenge);
      return { ...code, client, user: { ...user, concessaoId } };
    },
    async getAuthorizationCode(codigo: string) {
      const c = await deps.repo.lerCodigo(hashSegredo(codigo));
      if (!c) return null;
      if (c.usado) {
        await reuso(c.concessaoId, "CODIGO_REAPRESENTADO");
        return null;
      }
      const cimd = await deps.repo.clienteEmCache(c.clientId);
      return {
        authorizationCode: codigo, expiresAt: c.expiraEm, redirectUri: c.redirectUri, scope: [...c.escopos],
        client: { id: c.clientId, nome: cimd?.nome, redirectUris: cimd ? [...cimd.redirectUris] : [], grants: GRANTS },
        user: { usuarioId: c.usuarioId, empresaId: c.empresaId, concessaoId: c.concessaoId, recurso: "" } satisfies UsuarioOAuth,
        codeChallenge: c.codeChallenge, codeChallengeMethod: "S256",
      };
    },
    async revokeAuthorizationCode(code: { authorizationCode: string; user: UsuarioOAuth }) {
      const ok = await deps.repo.consumirCodigo(hashSegredo(code.authorizationCode));
      if (!ok && code.user.concessaoId) await reuso(code.user.concessaoId, "CODIGO_CONCORRENTE");
      return ok;
    },
    async saveToken(token: { accessToken: string; accessTokenExpiresAt?: Date; refreshToken?: string; refreshTokenExpiresAt?: Date; scope?: string[] }, client: { id: string }, user: UsuarioOAuth) {
      // Escopo EFETIVO do par emitido: o validado pela biblioteca (código = concedido; refresh = igual ou menor).
      const escopos = [...new Set((token.scope ?? []).filter(escopoValido))];
      if (!user.concessaoId || !token.accessTokenExpiresAt || escopos.length === 0) return null;
      await deps.repo.salvarTokens(
        user.concessaoId,
        escopos,
        { hash: hashSegredo(token.accessToken), expiraEm: token.accessTokenExpiresAt },
        token.refreshToken && token.refreshTokenExpiresAt ? { hash: hashSegredo(token.refreshToken), expiraEm: token.refreshTokenExpiresAt } : null,
      );
      return { ...token, client, user };
    },
    async getRefreshToken(refreshToken: string) {
      const g = await deps.repo.lerAtualizacao(hashSegredo(refreshToken));
      if (!g) return null;
      if (g.revogado) {
        await reuso(g.concessaoId, "REFRESH_REAPRESENTADO");
        return null;
      }
      // Limite de renovação POR CONCESSÃO (rodada 2, achado 3), conferido ANTES de girar: a recusa não consome o refresh,
      // o cliente tenta de novo depois com o mesmo token. O teto duro da gravação cobre a corrida acima deste limite.
      if ((await deps.repo.emissoesRecentes(g.concessaoId)) >= RETENCAO_OAUTH.emissoesPorHora) {
        throw new OAuth2Server.OAuthError("Renovações demais para esta conexão. Tente de novo mais tarde.", { code: 429, name: "temporarily_unavailable" });
      }
      return {
        refreshToken, refreshTokenExpiresAt: g.expiraEm, scope: [...g.escopos],
        client: { id: g.clientId, grants: GRANTS },
        user: { usuarioId: g.usuarioId, empresaId: g.empresaId, concessaoId: g.concessaoId, tokenId: g.tokenId, recurso: "" } satisfies UsuarioOAuth,
      };
    },
    async revokeToken(token: { user: UsuarioOAuth }) {
      if (!token.user.tokenId) return false;
      const ok = await deps.repo.revogarAtualizacao(token.user.tokenId);
      if (!ok && token.user.concessaoId) await reuso(token.user.concessaoId, "REFRESH_CONCORRENTE");
      return ok;
    },
    async getAccessToken() {
      // Verificação do acesso é feita por verificarAcesso (persistida, por pedido); a biblioteca não autentica recursos aqui.
      return null;
    },
  };
}

function servidor(deps: DependenciasOAuth) {
  const auditar = async (codigo: string, concessaoId: string) => {
    await deps.repo.auditar({ evento: "REUSO_DETECTADO", resultado: "REVOGADA", codigo, concessaoId });
  };
  return new OAuth2Server({
    model: modelo(deps, auditar) as never,
    accessTokenLifetime: PRAZOS_MCP.acessoS,
    refreshTokenLifetime: PRAZOS_MCP.atualizacaoS,
    authorizationCodeLifetime: PRAZOS_MCP.codigoS,
    allowEmptyState: true,
    allowBearerTokensInQueryString: false,
    alwaysIssueNewRefreshToken: true,
    requireClientAuthentication: { authorization_code: false, refresh_token: false },
  });
}

// ---------------------------------------------------------------- autorização (GET público → pedido pendente)

export type ResultadoAutorizacao =
  | { tipo: "CONSENTIMENTO"; destino: string }
  | { tipo: "REDIRECIONAR"; destino: string }
  | { tipo: "ERRO"; status: number; mensagem: string };

function comIss(destino: string, emissor: string) {
  const url = new URL(destino);
  url.searchParams.set("iss", emissor);
  return url.toString();
}

function redirecionarErro(redirectUri: string, erro: string, state: string | null, emissor: string): ResultadoAutorizacao {
  const url = new URL(redirectUri);
  url.searchParams.set("error", erro);
  if (state) url.searchParams.set("state", state);
  return { tipo: "REDIRECIONAR", destino: comIss(url.toString(), emissor) };
}

const PARAMETROS_UNICOS = ["response_type", "client_id", "redirect_uri", "scope", "state", "code_challenge", "code_challenge_method", "resource"];

/** Recusas ANÔNIMAS (sem pessoa/concessão): só contador em processo, nunca linha no banco (revisão P1-2). */
export type OpcoesBordaPublica = { contarAnonimo?: (codigo: string) => void; tetoPendentes?: number };

export async function iniciarAutorizacao(query: URLSearchParams, deps: DependenciasOAuth, opcoes: OpcoesBordaPublica = {}): Promise<ResultadoAutorizacao> {
  const contar = opcoes.contarAnonimo ?? (() => undefined);
  let urls: UrlsMcp;
  try {
    urls = exigirUrls(deps.env);
  } catch {
    return { tipo: "ERRO", status: 503, mensagem: "Conexão com assistentes externos indisponível." };
  }
  if (PARAMETROS_UNICOS.some((p) => query.getAll(p).length > 1)) {
    contar("PARAMETRO_DUPLICADO");
    return { tipo: "ERRO", status: 400, mensagem: "Pedido de autorização inválido." };
  }
  const clientId = query.get("client_id") ?? "";
  const redirectUri = query.get("redirect_uri") ?? "";
  let cliente: ClienteOAuth;
  try {
    cliente = await obterCliente(clientId, deps);
  } catch (error) {
    // Só recusa do CIMD vira 400; banco, prazo ou canal ocupado sobem como indisponibilidade (503 na rota).
    if (!(error instanceof CimdRecusado)) throw error;
    contar(`CIMD_${error.motivo}`);
    if (error.transitorio) return { tipo: "ERRO", status: 503, mensagem: "Não foi possível conferir o aplicativo agora. Tente de novo em instantes." };
    return { tipo: "ERRO", status: 400, mensagem: "Este aplicativo não está habilitado para conectar ao KidMais." };
  }
  // Sem redirect conferido, nunca redirecionar (open redirect).
  if (!cliente.redirectUris.includes(redirectUri)) {
    contar("REDIRECT_DIVERGENTE");
    return { tipo: "ERRO", status: 400, mensagem: "Endereço de retorno não autorizado para este aplicativo." };
  }
  const state = query.get("state");
  if (state !== null && (state.length > 500 || /[\u0000-\u001f]/.test(state))) {
    contar("STATE_INVALIDO");
    return { tipo: "ERRO", status: 400, mensagem: "Pedido de autorização inválido." };
  }
  const falhar = async (erro: string, codigo: string) => {
    contar(codigo);
    return redirecionarErro(redirectUri, erro, state, urls.emissor);
  };
  if (query.get("response_type") !== "code") return falhar("unsupported_response_type", "RESPONSE_TYPE");
  const challenge = query.get("code_challenge") ?? "";
  if (!VERIFIER.test(challenge) || query.get("code_challenge_method") !== "S256") return falhar("invalid_request", "PKCE_S256_OBRIGATORIO");
  if (query.get("resource") !== urls.recurso) return falhar("invalid_target", "RESOURCE");
  const pedidos = (query.get("scope") ?? "").split(" ").filter(Boolean);
  if (pedidos.some((e) => !escopoValido(e))) return falhar("invalid_scope", "ESCOPO_DESCONHECIDO");
  const escopos = pedidos.length ? [...new Set(pedidos)] as EscopoMcp[] : [...ESCOPOS_MCP];
  // Teto PERSISTENTE e ATÔMICO (vale entre conexões e instâncias; rodada 2, achado 2): conta e grava sob a mesma trava.
  const chave = novoSegredo("kmp");
  const admitido = await deps.repo.criarPedidoNoTeto(hashSegredo(chave), {
    clientId, clienteNome: cliente.nome, redirectUri, state, codeChallenge: challenge, escopos, recurso: urls.recurso,
    expiraEm: new Date(deps.agora().getTime() + PRAZOS_MCP.pedidoAutorizacaoS * 1000),
  }, opcoes.tetoPendentes ?? 5000);
  if (!admitido) {
    contar("PEDIDOS_PENDENTES_NO_TETO");
    return { tipo: "ERRO", status: 429, mensagem: "Muitas conexões pendentes para este aplicativo. Tente de novo em alguns minutos." };
  }
  return { tipo: "CONSENTIMENTO", destino: `${urls.origem}/admin/conexoes-ia/autorizar?pedido=${encodeURIComponent(chave)}` };
}

/**
 * Dados do pedido para a tela de consentimento (sem segredo). null ⇒ expirado, consumido ou inexistente.
 * `empresaNoPiloto` só orienta a tela (teste real de 28/10/2026: a sessão estava noutra empresa e o Permitir aparecia
 * para uma empresa fora do piloto). A barreira continua em `concluirConsentimento`, com a empresa comprovada.
 */
export async function lerPedidoParaConsentimento(chave: string, deps: DependenciasOAuth, empresaAtualId: string | null = null) {
  if (!/^kmp_[A-Za-z0-9_-]{43}$/.test(chave) || !mcpAtivo(deps.env)) return null;
  const p = await deps.repo.lerPedido(hashSegredo(chave));
  if (!p) return null;
  return {
    clienteNome: p.clienteNome, clientHost: new URL(p.clientId).hostname, redirectHost: new URL(p.redirectUri).hostname, escopos: p.escopos, expiraEm: p.expiraEm.toISOString(),
    empresaNoPiloto: empresaAtualId !== null && empresaNoPilotoMcp(deps.env, empresaAtualId),
  };
}

// ---------------------------------------------------------------- consentimento (sessão autenticada do KidMais)

export type DecisaoConsentimento = { pedido: string; empresaId: string; escopos: readonly string[]; decisao: "PERMITIR" | "NEGAR" };

export async function concluirConsentimento(entrada: DecisaoConsentimento, sessao: SessaoParaTenant, deps: DependenciasConsentimento): Promise<{ destino: string }> {
  const urls = exigirUrls(deps.env);
  if (!/^kmp_[A-Za-z0-9_-]{43}$/.test(entrada.pedido)) throw new ErroOAuth(400, "invalid_request", "Pedido de conexão inválido ou expirado.");
  const chaveHash = hashSegredo(entrada.pedido);
  const pendente = await deps.repo.lerPedido(chaveHash);
  if (!pendente) throw new ErroOAuth(400, "invalid_request", "Pedido de conexão inválido ou expirado.");

  if (entrada.decisao === "NEGAR") {
    const consumido = await deps.repo.consumirPedido(chaveHash);
    if (!consumido) throw new ErroOAuth(400, "invalid_request", "Pedido de conexão inválido ou expirado.");
    await deps.repo.auditar({ evento: "AUTORIZACAO_NEGADA", resultado: "NEGADO", codigo: "USUARIO_NEGOU", usuarioId: sessao.usuario_id, clientId: consumido.clientId });
    const r = redirecionarErro(consumido.redirectUri, "access_denied", consumido.state, urls.emissor);
    return { destino: (r as { destino: string }).destino };
  }

  // Elevação de escopo: só o que o aplicativo pediu, ao menos um, sem repetição.
  const escopos = [...new Set(entrada.escopos)];
  if (escopos.length === 0 || escopos.some((e) => !escopoValido(e) || !pendente.escopos.includes(e))) {
    throw new ErroOAuth(400, "invalid_scope", "Escolha ao menos uma permissão entre as solicitadas pelo aplicativo.");
  }
  const manifesto = manifestoLeitura(agendaDoDia);
  const tenant = await deps.withTenantTransaction(sessao, entrada.empresaId, async (tx, comprovado) => {
    if (!empresaNoPilotoMcp(deps.env, comprovado.empresaComprovada)) throw new ErroOAuth(403, "access_denied", "Esta empresa ainda não participa do piloto de conexões com assistentes.");
    const r = decidirPolitica({ papel: comprovado.papelAtual, manifesto, caminho: "LEITURA", origem: "UI", grupoAtivo: true, grupoAtivoNaEmpresa: true, estabelecimento: null });
    if (r !== "PERMITIDO") throw new ErroOAuth(403, "access_denied", "Seu acesso nesta empresa não permite conectar assistentes.");
    if (!(await deps.leituraComercialPermitida(tx, comprovado.empresaComprovada))) throw new ErroOAuth(402, "access_denied", "A situação da assinatura desta empresa não permite novas conexões.");
    return comprovado;
  });
  const consumido = await deps.repo.consumirPedido(chaveHash);
  if (!consumido) throw new ErroOAuth(400, "invalid_request", "Pedido de conexão inválido ou expirado.");

  const usuario: UsuarioOAuth = { usuarioId: tenant.usuarioId, empresaId: tenant.empresaComprovada, recurso: consumido.recurso };
  const query: Record<string, string> = {
    response_type: "code", client_id: consumido.clientId, redirect_uri: consumido.redirectUri, scope: escopos.join(" "),
    code_challenge: consumido.codeChallenge, code_challenge_method: "S256", ...(consumido.state ? { state: consumido.state } : {}),
  };
  const req = new OAuth2Server.Request({ method: "GET", headers: {}, query, body: {} });
  const res = new OAuth2Server.Response({ headers: {} });
  const codigo = await servidor(deps).authorize(req, res, { authenticateHandler: { handle: () => usuario } });
  const destino = res.headers?.location;
  if (!destino) throw indisponivel();
  await deps.repo.auditar({
    evento: "AUTORIZACAO_CONCEDIDA", resultado: "OK", codigo: escopos.sort().join(","), usuarioId: tenant.usuarioId, empresaId: tenant.empresaComprovada,
    clientId: consumido.clientId, concessaoId: (codigo.user as UsuarioOAuth).concessaoId ?? null,
  });
  return { destino: comIss(destino, urls.emissor) };
}

// ---------------------------------------------------------------- token

export type RespostaToken = { status: number; corpo: Record<string, unknown> };

export async function trocarToken(form: URLSearchParams, deps: DependenciasOAuth, opcoes: OpcoesBordaPublica = {}): Promise<RespostaToken> {
  const contar = opcoes.contarAnonimo ?? (() => undefined);
  const recusar = (codigo: string, corpo: Record<string, unknown>): RespostaToken => {
    contar(codigo);
    return { status: 400, corpo };
  };
  let urls: UrlsMcp;
  try {
    urls = exigirUrls(deps.env);
  } catch {
    return { status: 503, corpo: { error: "temporarily_unavailable" } };
  }
  const unicos = ["grant_type", "code", "code_verifier", "redirect_uri", "client_id", "refresh_token", "scope", "resource"];
  if (unicos.some((p) => form.getAll(p).length > 1)) return recusar("TOKEN_PARAMETRO_DUPLICADO", { error: "invalid_request" });
  const grant = form.get("grant_type");
  if (grant !== "authorization_code" && grant !== "refresh_token") return recusar("TOKEN_GRANT_TYPE", { error: "unsupported_grant_type" });
  const resource = form.get("resource");
  if (resource !== null && resource !== urls.recurso) return recusar("TOKEN_RESOURCE", { error: "invalid_target" });
  if (grant === "authorization_code" && !VERIFIER.test(form.get("code_verifier") ?? "")) return recusar("TOKEN_PKCE", { error: "invalid_request", error_description: "PKCE obrigatório." });
  const body = Object.fromEntries(form.entries());
  const texto = form.toString();
  const req = new OAuth2Server.Request({
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "content-length": String(Buffer.byteLength(texto)) },
    query: {},
    body,
  });
  const res = new OAuth2Server.Response({ headers: {} });
  try {
    const token = await servidor(deps).token(req, res);
    const user = token.user as UsuarioOAuth;
    await deps.repo.auditar({
      evento: grant === "authorization_code" ? "TOKEN_EMITIDO" : "TOKEN_RENOVADO", resultado: "OK", codigo: grant.toUpperCase(),
      concessaoId: user.concessaoId ?? null, usuarioId: user.usuarioId, empresaId: user.empresaId, clientId: (token.client as { id: string }).id,
    });
    return { status: 200, corpo: res.body as Record<string, unknown> };
  } catch (error) {
    const e = error as { name?: string; code?: number };
    const nome = typeof e.name === "string" && /^[a-z_]+$/.test(e.name) ? e.name : "server_error";
    // Rodada 5, P3: erro interno (banco indisponível, canal ocupado, prazo, CIMD transitório) chega aqui como server_error
    // da biblioteca: é indisponibilidade, não defeito do pedido ⇒ 503 temporarily_unavailable, contado como tal.
    if (nome === "server_error") {
      contar("TOKEN_INDISPONIVEL");
      return { status: 503, corpo: { error: "temporarily_unavailable" } };
    }
    contar(`TOKEN_${nome.toUpperCase()}`);
    const status = typeof e.code === "number" && e.code >= 400 && e.code < 600 ? e.code : 500;
    return { status, corpo: { error: nome } };
  }
}

// ---------------------------------------------------------------- verificação do acesso (cada pedido MCP)

export type VerificacaoAcesso = { ok: true; acesso: AcessoVerificado } | { ok: false; status: 401 | 503; erro: "invalid_token" | "temporarily_unavailable" };

export async function verificarAcesso(autorizacao: string | null, deps: DependenciasOAuth): Promise<VerificacaoAcesso> {
  const urls = urlsMcp(deps.env);
  if (!mcpAtivo(deps.env) || !urls) return { ok: false, status: 503, erro: "temporarily_unavailable" };
  const m = /^Bearer (kma_[A-Za-z0-9_-]{43})$/.exec(autorizacao ?? "");
  if (!m) return { ok: false, status: 401, erro: "invalid_token" };
  const acesso = await deps.repo.verificarAcesso(hashSegredo(m[1]));
  // Audience: o token só vale para ESTE recurso (outra URL/servidor ⇒ recusa).
  if (!acesso || acesso.recurso !== urls.recurso) return { ok: false, status: 401, erro: "invalid_token" };
  return { ok: true, acesso };
}
