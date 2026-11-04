import type { exigirConfiguracaoWhatsappPrivada } from './configuracao.ts';
import { WhatsappOnboardingError } from './errors.ts';

type Config = ReturnType<typeof exigirConfiguracaoWhatsappPrivada>;
/** Leituras só precisam da versão da Graph (a demonstração de ativos de teste não usa segredo do app). */
type ConfigLeitura = Pick<Config, 'graphApiVersion'>;
type Fetch = typeof fetch;
type GraphList<T> = { data?: T[]; paging?: { next?: unknown }; error?: unknown };

/** Etapas da conexão com a Meta que podem ser registradas quando falham (lista fechada). */
export type EtapaMeta = 'troca_codigo' | 'debug_token' | 'dono_waba' | 'numeros';
const inteiroSeguro = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 999_999_999 ? v : null);
/** Tipos de erro da Graph API registráveis (lista fechada); qualquer outro valor vira 'outro'. */
const TIPOS_ERRO_META = ['OAuthException', 'GraphMethodException', 'FacebookApiException', 'GraphBatchException'] as const;
/** Marca de corpo não lido: na falha do provedor (5xx do dono) a recusa não espera a leitura do corpo. */
export const CORPO_NAO_LIDO = Symbol('corpo-nao-lido');
/**
 * Registro SEGURO da recusa da Meta (03/11/2026: a tentativa real em staging parou em META_API_RECUSOU sem nenhum rastro
 * de qual etapa falhou). Só valores de LISTA FECHADA ou inteiros: etapa, status HTTP, estado do corpo, `error.code`,
 * `error.error_subcode` (inteiros de 0 a 999.999.999) e `error.type` (lista fechada; fora dela, 'outro'). Nenhum texto
 * vindo da Meta é copiado: `error.message` e `fbtrace_id` ficam de fora, assim como URL, código, token e segredo.
 */
export function registroRecusaMeta(etapa: EtapaMeta, httpStatus: number, body: unknown) {
  const lido = body !== CORPO_NAO_LIDO;
  const erro = lido && body && typeof body === 'object' && !Array.isArray(body) ? (body as { error?: unknown }).error : undefined;
  const e = erro && typeof erro === 'object' && !Array.isArray(erro) ? erro as Record<string, unknown> : {};
  return {
    whatsappMetaRecusa: {
      etapa,
      http: inteiroSeguro(httpStatus),
      corpo: !lido ? 'nao_lido' : body === null ? 'ilegivel' : erro === undefined ? 'sem_erro' : 'com_erro',
      codigo: inteiroSeguro(e.code),
      subcodigo: inteiroSeguro(e.error_subcode),
      tipo: e.type === undefined ? null : (TIPOS_ERRO_META as readonly unknown[]).includes(e.type) ? e.type as typeof TIPOS_ERRO_META[number] : 'outro',
    },
  };
}
function registrarRecusaMeta(etapa: EtapaMeta, httpStatus: number, body: unknown) {
  console.warn(JSON.stringify(registroRecusaMeta(etapa, httpStatus, body)));
}

async function respostaJson(response: Response, etapa: EtapaMeta) {
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok || !body || body.error) {
    registrarRecusaMeta(etapa, response.status, body);
    throw new WhatsappOnboardingError('META_API_RECUSOU', 'A Meta recusou a validação da configuração.', 502);
  }
  return body;
}
async function graphGet(path: string, token: string, config: ConfigLeitura, fetchImpl: Fetch, etapa: EtapaMeta) {
  return respostaJson(await fetchImpl(`https://graph.facebook.com/${config.graphApiVersion}${path}`, {
    method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, cache: 'no-store',
  }), etapa);
}

/** IDs explícitos de um escopo granular; sem `target_ids` (escopo sobre todos os objetos) não há prova da AUTORIZAÇÃO do ativo. */
function alvosDoEscopo(granular: unknown[], scope: string): string[] | null {
  const item = granular.find((entrada): entrada is { scope: string; target_ids?: unknown } => Boolean(entrada) && typeof entrada === 'object' && (entrada as { scope?: unknown }).scope === scope);
  return Array.isArray(item?.target_ids) ? item.target_ids.map(String) : null;
}

const RELACAO_NAO_CONFIRMADA = () => new WhatsappOnboardingError('META_RELACAO_NAO_CONFIRMADA', 'A Meta não confirmou que a conta WhatsApp pertence ao negócio informado.', 409);

/**
 * PERTENCIMENTO WABA ↔ negócio pela aresta documentada `/{business}/owned_whatsapp_business_accounts`. Exige
 * `business_management` (sem ele a Meta responde 403, prova P-DONO-WABA de 03/11): por isso só a demonstração de ativos
 * de teste a usa; a conexão do cliente usa `negocioDonoDaWaba`. Recusa da Meta (4xx), resposta sem lista ou lista
 * paginada sem a WABA: relação NÃO confirmada (fail-closed). Falha do provedor (5xx/rede): recusa genérica.
 */
export async function wabaPertenceAoNegocio(businessId: string, wabaId: string, token: string, config: ConfigLeitura, fetchImpl: Fetch) {
  const response = await fetchImpl(`https://graph.facebook.com/${config.graphApiVersion}/${businessId}/owned_whatsapp_business_accounts?fields=id&limit=100`, {
    method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, cache: 'no-store',
  });
  if (response.status >= 500) throw new WhatsappOnboardingError('META_API_RECUSOU', 'A Meta recusou a validação da configuração.', 502);
  const body = await response.json().catch(() => null) as { data?: unknown; paging?: { next?: unknown }; error?: unknown } | null;
  if (!response.ok || !body || body.error || !Array.isArray(body.data)) throw RELACAO_NAO_CONFIRMADA();
  const ids = body.data.map((item) => (item && typeof item === 'object' ? (item as { id?: unknown }).id : undefined));
  if (ids.some((id) => typeof id !== 'string' && typeof id !== 'number')) throw RELACAO_NAO_CONFIRMADA();
  if (ids.map(String).includes(wabaId)) return true;
  if (body.paging?.next) throw RELACAO_NAO_CONFIRMADA();
  return false;
}

/** Números da WABA com os campos que a conexão confere (inclusive `is_on_biz_app`). Só leitura. */
export async function lerNumerosDaWaba(wabaId: string, token: string, config: ConfigLeitura, fetchImpl: Fetch) {
  return await graphGet(`/${wabaId}/phone_numbers?fields=id,display_phone_number,verified_name,status,account_mode,is_on_biz_app&limit=100`, token, config, fetchImpl, 'numeros') as GraphList<Record<string, unknown>>;
}

/**
 * Negócio DONO da WABA, lido no servidor com o token do cliente: `GET /{waba}?fields=id,owner_business_info`. Só roda
 * depois de a WABA constar dos ativos que ESTE token autorizou. Não exige `business_management`, que a análise do app
 * recusou em 03/11/2026: a prova P-DONO-WABA (token sem o escopo) devolveu o negócio certo. O campo não consta da
 * referência oficial da WABA, por isso tudo fora do esperado recusa (fail-closed): erro da Meta (4xx), corpo de outra
 * WABA, campo ausente ou id não numérico. Falha do provedor (5xx): recusa genérica das demais etapas.
 */
async function negocioDonoDaWaba(wabaId: string, token: string, config: ConfigLeitura, fetchImpl: Fetch) {
  const response = await fetchImpl(`https://graph.facebook.com/${config.graphApiVersion}/${wabaId}?fields=id,owner_business_info`, {
    method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, cache: 'no-store',
  });
  if (response.status >= 500) {
    // Como antes da mudança, o status basta: a recusa não espera o corpo (que pode nunca terminar de chegar).
    registrarRecusaMeta('dono_waba', response.status, CORPO_NAO_LIDO);
    throw new WhatsappOnboardingError('META_API_RECUSOU', 'A Meta recusou a validação da configuração.', 502);
  }
  const body = await response.json().catch(() => null) as { id?: unknown; owner_business_info?: unknown; error?: unknown } | null;
  if (!response.ok || !body || body.error) registrarRecusaMeta('dono_waba', response.status, body);
  if (!response.ok || !body || body.error || String(body.id ?? '') !== wabaId) throw RELACAO_NAO_CONFIRMADA();
  const dono = body.owner_business_info;
  const id = dono && typeof dono === 'object' ? (dono as { id?: unknown }).id : undefined;
  if ((typeof id !== 'string' && typeof id !== 'number') || !/^[0-9]{1,64}$/.test(String(id))) throw RELACAO_NAO_CONFIRMADA();
  return String(id);
}

/**
 * Número a conectar. Informado pelo evento: precisa estar na WABA. Ausente (fluxo do WhatsApp Business App): o único
 * número da WABA em coexistência (`is_on_biz_app`); nenhum, mais de um ou lista paginada: recusa.
 */
function numeroDaConexao(phones: GraphList<Record<string, unknown>>, phoneNumberId: string | undefined) {
  if (phoneNumberId) {
    const phone = phones.data?.find((item) => String(item.id) === phoneNumberId);
    if (!phone) throw new WhatsappOnboardingError('META_NUMERO_DIVERGENTE', 'O número não pertence à conta WhatsApp autorizada.', 409);
    return phone;
  }
  const coexistentes = (phones.data ?? []).filter((item) => item.is_on_biz_app === true);
  if (phones.paging?.next || coexistentes.length > 1) throw new WhatsappOnboardingError('META_NUMERO_AMBIGUO', 'A conta WhatsApp tem mais de um número do WhatsApp Business App; não é possível saber qual conectar.', 409);
  if (coexistentes.length === 0) throw new WhatsappOnboardingError('META_COEXISTENCIA_NAO_CONFIRMADA', 'A Meta não confirmou a coexistência com o WhatsApp Business App.', 409);
  return coexistentes[0];
}

/**
 * Inscrição do app nos webhooks DA WABA comprovada (#168): sem ela a Meta não entrega mensagens nem status do número.
 * É uma ESCRITA EXTERNA: confirmada, a Meta pode entregar eventos dessa WABA antes de existir conexão local (o webhook
 * só grava eventos de número com conexão CONFIGURADA; os demais são confirmados sem gravar). Por isso roda por último,
 * depois de toda a validação, e o resultado tem TRÊS classes (JSON legível não comprova o resultado da escrita):
 *  - sucesso confirmado: 2xx com objeto JSON e `success === true` (booleano);
 *  - recusa explícita (META_WEBHOOK_NAO_INSCRITO, a WABA não ficou inscrita): 2xx com objeto e `success === false`
 *    (booleano), ou 4xx com objeto JSON contendo `error` objeto (a Meta rejeitou a chamada);
 *  - resultado desconhecido (META_WEBHOOK_INSCRICAO_INCERTA, a WABA PODE ter ficado inscrita): todo o resto. Rede,
 *    prazo esgotado, 5xx, corpo ilegível, 2xx com `{}`, `null`, array ou `success` de outro tipo, e 4xx sem `error`.
 * Nenhuma desinscrição automática: a mesma WABA pode servir a outra conexão ou ambiente do mesmo app (ver docs).
 */
const PRAZO_INSCRICAO_MS = 10_000;
const INSCRICAO_INCERTA = () => new WhatsappOnboardingError('META_WEBHOOK_INSCRICAO_INCERTA', 'Não foi possível confirmar o recebimento de mensagens deste número. Tente conectar de novo.', 502);
const objetoJson = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
async function inscreverAppNaWaba(wabaId: string, token: string, config: Config, fetchImpl: Fetch) {
  let response: Response;
  let corpo: unknown;
  try {
    // Prazo próprio cobre a chamada e a leitura do corpo; esgotado, a escrita pode ter ocorrido: INCERTA.
    response = await fetchImpl(`https://graph.facebook.com/${config.graphApiVersion}/${wabaId}/subscribed_apps`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, cache: 'no-store', signal: AbortSignal.timeout(PRAZO_INSCRICAO_MS),
    });
    corpo = await response.json();
  } catch {
    throw INSCRICAO_INCERTA();
  }
  if (response.status >= 200 && response.status <= 299 && objetoJson(corpo)) {
    if (corpo.success === true) return;
    if (corpo.success === false) throw new WhatsappOnboardingError('META_WEBHOOK_NAO_INSCRITO', 'A Meta não confirmou o recebimento de mensagens deste número. Tente conectar de novo.', 502);
  }
  if (response.status >= 400 && response.status <= 499 && objetoJson(corpo) && objetoJson(corpo.error)) {
    throw new WhatsappOnboardingError('META_WEBHOOK_NAO_INSCRITO', 'A Meta não confirmou o recebimento de mensagens deste número. Tente conectar de novo.', 502);
  }
  throw INSCRICAO_INCERTA();
}

/** `businessId` e `phoneNumberId` podem faltar no evento da Meta: são então resolvidos e comprovados aqui e devolvidos. */
export async function trocarCodigoEValidarAtivos(input: { code: string; wabaId: string; businessId?: string; phoneNumberId?: string }, config: Config, fetchImpl: Fetch = fetch) {
  const oauth = new URL(`https://graph.facebook.com/${config.graphApiVersion}/oauth/access_token`);
  // Troca documentada do Embedded Signup (Tech Provider): só client_id, client_secret e code, SEM redirect_uri. O código
  // vem do FB.login do SDK. Causa PROVÁVEL da recusa na tentativa real em staging de 03/11/2026 (23:27Z): o envio de
  // META_OAUTH_REDIRECT_URI na troca (a etapa não era registrada). O código vale 30 s: a troca roda logo após o evento.
  oauth.searchParams.set('client_id', config.appId);
  oauth.searchParams.set('client_secret', config.appSecret);
  oauth.searchParams.set('code', input.code);
  const tokenBody = await respostaJson(await fetchImpl(oauth, { method: 'GET', headers: { Accept: 'application/json' }, cache: 'no-store' }), 'troca_codigo');
  const accessToken = typeof tokenBody.access_token === 'string' ? tokenBody.access_token : '';
  const tokenType = typeof tokenBody.token_type === 'string' ? tokenBody.token_type : 'UNKNOWN';
  const expiresIn = typeof tokenBody.expires_in === 'number' ? tokenBody.expires_in : null;
  if (!accessToken) throw new WhatsappOnboardingError('META_TOKEN_INVALIDO', 'A Meta não retornou uma credencial válida.', 502);

  const debug = new URL(`https://graph.facebook.com/${config.graphApiVersion}/debug_token`);
  debug.searchParams.set('input_token', accessToken);
  debug.searchParams.set('access_token', `${config.appId}|${config.appSecret}`);
  const debugBody = await respostaJson(await fetchImpl(debug, { method: 'GET', headers: { Accept: 'application/json' }, cache: 'no-store' }), 'debug_token');
  const debugData = debugBody.data as Record<string, unknown> | undefined;
  const scopes = Array.isArray(debugData?.scopes) ? debugData.scopes.filter((item): item is string => typeof item === 'string') : [];
  if (debugData?.is_valid !== true || String(debugData.app_id ?? '') !== config.appId
      || !['whatsapp_business_management', 'whatsapp_business_messaging'].every((scope) => scopes.includes(scope))) {
    throw new WhatsappOnboardingError('META_ESCOPO_INVALIDO', 'A autorização Meta não concedeu os acessos necessários.', 409);
  }
  // AUTORIZAÇÃO: a WABA entre os ativos que ESTE token autorizou (debug_token.granular_scopes.target_ids). O negócio vem
  // do dono da WABA lido no servidor (negocioDonoDaWaba), nunca do navegador; o informado no evento só é conferido.
  // `client_whatsapp_business_accounts` lista as WABAs compartilhadas COM o portfólio do parceiro e não serve aqui.
  const granular = debugData?.granular_scopes;
  if (!Array.isArray(granular)) throw new WhatsappOnboardingError('META_AUTORIZACAO_INCOMPLETA', 'A Meta não informou quais ativos foram autorizados.', 409);
  if (!alvosDoEscopo(granular, 'whatsapp_business_management')?.includes(input.wabaId)) throw new WhatsappOnboardingError('META_WABA_DIVERGENTE', 'A conta WhatsApp não foi autorizada nesta conexão.', 409);
  const businessId = await negocioDonoDaWaba(input.wabaId, accessToken, config, fetchImpl);
  if (input.businessId && input.businessId !== businessId) throw new WhatsappOnboardingError('META_WABA_DIVERGENTE', 'A conta WhatsApp não pertence ao negócio informado.', 409);
  const phones = await lerNumerosDaWaba(input.wabaId, accessToken, config, fetchImpl);
  const phone = numeroDaConexao(phones, input.phoneNumberId);
  const phoneNumberId = String(phone.id ?? '');
  if (!/^[0-9]{1,64}$/.test(phoneNumberId)) throw new WhatsappOnboardingError('META_NUMERO_INCOMPLETO', 'A Meta não retornou a identificação completa do número.', 409);
  if (phone.is_on_biz_app !== true) throw new WhatsappOnboardingError('META_COEXISTENCIA_NAO_CONFIRMADA', 'A Meta não confirmou a coexistência com o WhatsApp Business App.', 409);
  const displayPhoneNumber = typeof phone.display_phone_number === 'string' ? phone.display_phone_number : '';
  const verifiedName = typeof phone.verified_name === 'string' ? phone.verified_name : '';
  if (!displayPhoneNumber || !verifiedName) throw new WhatsappOnboardingError('META_NUMERO_INCOMPLETO', 'A Meta não retornou a identificação completa do número.', 409);
  // Última etapa: só a WABA já comprovada (posse, número e coexistência) recebe a inscrição.
  await inscreverAppNaWaba(input.wabaId, accessToken, config, fetchImpl);
  return { accessToken, tokenType, scopes, expiresAt: expiresIn && expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000) : null, displayPhoneNumber, verifiedName, businessId, phoneNumberId, webhookInscrito: true as const };
}
