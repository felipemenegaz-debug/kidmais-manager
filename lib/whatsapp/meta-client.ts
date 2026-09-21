import type { exigirConfiguracaoWhatsappPrivada } from './configuracao.ts';
import { WhatsappOnboardingError } from './errors.ts';

type Config = ReturnType<typeof exigirConfiguracaoWhatsappPrivada>;
type Fetch = typeof fetch;
type GraphList<T> = { data?: T[]; error?: unknown };

async function respostaJson(response: Response) {
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok || !body || body.error) throw new WhatsappOnboardingError('META_API_RECUSOU', 'A Meta recusou a validação da configuração.', 502);
  return body;
}
async function graphGet(path: string, token: string, config: Config, fetchImpl: Fetch) {
  return respostaJson(await fetchImpl(`https://graph.facebook.com/${config.graphApiVersion}${path}`, {
    method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, cache: 'no-store',
  }));
}

export async function trocarCodigoEValidarAtivos(input: { code: string; businessId: string; wabaId: string; phoneNumberId: string }, config: Config, fetchImpl: Fetch = fetch) {
  const oauth = new URL(`https://graph.facebook.com/${config.graphApiVersion}/oauth/access_token`);
  oauth.searchParams.set('client_id', config.appId);
  oauth.searchParams.set('redirect_uri', config.redirectUri);
  oauth.searchParams.set('client_secret', config.appSecret);
  oauth.searchParams.set('code', input.code);
  const tokenBody = await respostaJson(await fetchImpl(oauth, { method: 'GET', headers: { Accept: 'application/json' }, cache: 'no-store' }));
  const accessToken = typeof tokenBody.access_token === 'string' ? tokenBody.access_token : '';
  const tokenType = typeof tokenBody.token_type === 'string' ? tokenBody.token_type : 'UNKNOWN';
  const expiresIn = typeof tokenBody.expires_in === 'number' ? tokenBody.expires_in : null;
  if (!accessToken) throw new WhatsappOnboardingError('META_TOKEN_INVALIDO', 'A Meta não retornou uma credencial válida.', 502);

  const debug = new URL(`https://graph.facebook.com/${config.graphApiVersion}/debug_token`);
  debug.searchParams.set('input_token', accessToken);
  debug.searchParams.set('access_token', `${config.appId}|${config.appSecret}`);
  const debugBody = await respostaJson(await fetchImpl(debug, { method: 'GET', headers: { Accept: 'application/json' }, cache: 'no-store' }));
  const debugData = debugBody.data as Record<string, unknown> | undefined;
  const scopes = Array.isArray(debugData?.scopes) ? debugData.scopes.filter((item): item is string => typeof item === 'string') : [];
  if (debugData?.is_valid !== true || String(debugData.app_id ?? '') !== config.appId
      || !['whatsapp_business_management', 'whatsapp_business_messaging'].every((scope) => scopes.includes(scope))) {
    throw new WhatsappOnboardingError('META_ESCOPO_INVALIDO', 'A autorização Meta não concedeu os acessos necessários.', 409);
  }
  const businessWabas = await graphGet(`/${input.businessId}/client_whatsapp_business_accounts?fields=id&limit=100`, accessToken, config, fetchImpl) as GraphList<{ id?: string }>;
  if (!businessWabas.data?.some((item) => String(item.id) === input.wabaId)) throw new WhatsappOnboardingError('META_WABA_DIVERGENTE', 'A conta WhatsApp não pertence ao negócio autorizado.', 409);
  const phones = await graphGet(`/${input.wabaId}/phone_numbers?fields=id,display_phone_number,verified_name,status,account_mode,is_on_biz_app&limit=100`, accessToken, config, fetchImpl) as GraphList<Record<string, unknown>>;
  const phone = phones.data?.find((item) => String(item.id) === input.phoneNumberId);
  if (!phone) throw new WhatsappOnboardingError('META_NUMERO_DIVERGENTE', 'O número não pertence à conta WhatsApp autorizada.', 409);
  if (phone.is_on_biz_app !== true) throw new WhatsappOnboardingError('META_COEXISTENCIA_NAO_CONFIRMADA', 'A Meta não confirmou a coexistência com o WhatsApp Business App.', 409);
  const displayPhoneNumber = typeof phone.display_phone_number === 'string' ? phone.display_phone_number : '';
  const verifiedName = typeof phone.verified_name === 'string' ? phone.verified_name : '';
  if (!displayPhoneNumber || !verifiedName) throw new WhatsappOnboardingError('META_NUMERO_INCOMPLETO', 'A Meta não retornou a identificação completa do número.', 409);
  return { accessToken, tokenType, scopes, expiresAt: expiresIn && expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000) : null, displayPhoneNumber, verifiedName };
}
