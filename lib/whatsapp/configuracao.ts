import { WhatsappOnboardingError } from './errors.ts';

export type AmbienteWhatsapp = 'STAGING' | 'PRODUCTION';
type Env = NodeJS.ProcessEnv | Record<string, string | undefined>;
const chaveSensivel = /(?:secret|token|password|credential|authorization|pepper)/i;

function texto(env: Env, nome: string) { return env[nome]?.trim() ?? ''; }
function ambiente(env: Env): AmbienteWhatsapp | null {
  const valor = texto(env, 'KIDMAIS_DEPLOY_ENV').toLowerCase();
  return valor === 'staging' ? 'STAGING' : valor === 'production' ? 'PRODUCTION' : null;
}
function idMeta(valor: string) { return /^[0-9]+$/.test(valor); }

function opcoesPublicas(raw: string, configId: string): Record<string, unknown> | null {
  if (!raw || raw.length > 10_000) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || Array.isArray(value) || typeof value !== 'object') return null;
    const visitar = (item: unknown): boolean => {
      if (Array.isArray(item)) return item.every(visitar);
      if (!item || typeof item !== 'object') return true;
      return Object.entries(item).every(([key, nested]) => !chaveSensivel.test(key) && visitar(nested));
    };
    if (!visitar(value)) return null;
    const options = value as Record<string, unknown>;
    if (options.config_id != null && options.config_id !== configId) return null;
    if (options.response_type !== 'code' || options.override_default_response_type !== true) return null;
    return { ...options, config_id: configId };
  } catch { return null; }
}

function origensMensagem(raw: string) {
  const values = raw.split(',').map((item) => item.trim()).filter(Boolean);
  if (values.length === 0 || new Set(values).size !== values.length) return null;
  try {
    const origins = values.map((value) => new URL(value));
    if (origins.some((url) => url.origin !== url.href.replace(/\/$/, '') || url.protocol !== 'https:' || !(url.hostname === 'facebook.com' || url.hostname.endsWith('.facebook.com')))) return null;
    return origins.map((url) => url.origin);
  } catch { return null; }
}

export function configuracaoWhatsappPublica(env: Env = process.env) {
  const deploy = ambiente(env);
  const appId = texto(env, 'META_APP_ID');
  const graphApiVersion = texto(env, 'META_GRAPH_API_VERSION');
  const configurationId = texto(env, 'META_EMBEDDED_SIGNUP_CONFIG_ID');
  const redirectUri = texto(env, 'META_OAUTH_REDIRECT_URI');
  const eventName = texto(env, 'META_EMBEDDED_SIGNUP_EVENT_NAME');
  const launchOptions = opcoesPublicas(texto(env, 'META_EMBEDDED_SIGNUP_OPTIONS_JSON'), configurationId);
  const messageOrigins = origensMensagem(texto(env, 'META_EMBEDDED_SIGNUP_MESSAGE_ORIGINS'));
  let redirectValido = false;
  try {
    const url = new URL(redirectUri);
    redirectValido = url.protocol === 'https:' && !url.username && !url.password && !url.hash && !url.search;
  } catch { /* configuração pendente */ }
  const pronta = deploy !== null && idMeta(appId) && /^v[0-9]+\.[0-9]+$/.test(graphApiVersion)
    && idMeta(configurationId) && redirectValido && /^[A-Z0-9_]{3,100}$/.test(eventName)
    && launchOptions !== null && messageOrigins !== null;
  return {
    pronta, ambiente: deploy,
    appId: pronta ? appId : null,
    graphApiVersion: pronta ? graphApiVersion : null,
    configurationId: pronta ? configurationId : null,
    redirectUri: pronta ? redirectUri : null,
    eventName: pronta ? eventName : null,
    launchOptions: pronta ? launchOptions : null,
    messageOrigins: pronta ? messageOrigins : null,
  };
}

export function configuracaoWhatsappServidorPronta(env: Env = process.env) {
  try {
    exigirConfiguracaoWhatsappPrivada(env);
    const raw = texto(env, 'WHATSAPP_CREDENTIAL_ENCRYPTION_KEY');
    const version = Number(texto(env, 'WHATSAPP_CREDENTIAL_KEY_VERSION'));
    return Buffer.from(raw, 'base64').length === 32 && Number.isSafeInteger(version) && version > 0;
  } catch {
    return false;
  }
}

export function exigirConfiguracaoWhatsappPrivada(env: Env = process.env) {
  const publica = configuracaoWhatsappPublica(env);
  const appSecret = texto(env, 'META_APP_SECRET');
  if (!publica.pronta || !publica.ambiente || !publica.appId || !publica.graphApiVersion || !publica.redirectUri || appSecret.length < 16) {
    throw new WhatsappOnboardingError('META_CONFIGURACAO_PENDENTE', 'Configuração Meta pendente.', 503);
  }
  return { ...publica, appId: publica.appId, graphApiVersion: publica.graphApiVersion, redirectUri: publica.redirectUri, ambiente: publica.ambiente, appSecret };
}
