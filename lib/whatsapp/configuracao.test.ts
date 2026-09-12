import assert from 'node:assert/strict';
import test from 'node:test';
import { configuracaoWhatsappPublica, configuracaoWhatsappServidorPronta } from './configuracao.ts';

function envValido() {
  return {
    KIDMAIS_DEPLOY_ENV: 'staging',
    META_APP_ID: '123456789',
    META_APP_SECRET: 'segredo-sintetico-com-mais-de-16',
    META_GRAPH_API_VERSION: 'v24.0',
    META_EMBEDDED_SIGNUP_CONFIG_ID: '987654321',
    META_OAUTH_REDIRECT_URI: 'https://staging.example.invalid/admin/configuracoes/whatsapp',
    META_EMBEDDED_SIGNUP_OPTIONS_JSON: JSON.stringify({ response_type: 'code', override_default_response_type: true, extras: { feature: 'coexistence' } }),
    META_EMBEDDED_SIGNUP_EVENT_NAME: 'FINISH',
    META_EMBEDDED_SIGNUP_MESSAGE_ORIGINS: 'https://www.facebook.com',
    WHATSAPP_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    WHATSAPP_CREDENTIAL_KEY_VERSION: '1',
  };
}

test('configuração aceita callback HTTPS com caminho e snippet explícito do painel', () => {
  const env = envValido();
  const config = configuracaoWhatsappPublica(env);
  assert.equal(config.pronta, true);
  assert.deepEqual(config.launchOptions, {
    response_type: 'code', override_default_response_type: true,
    extras: { feature: 'coexistence' }, config_id: env.META_EMBEDDED_SIGNUP_CONFIG_ID,
  });
  assert.equal(configuracaoWhatsappServidorPronta(env), true);
});

test('configuração rejeita HTTP, origem Meta indevida e chave sensível no snippet', () => {
  for (const alteracao of [
    { META_OAUTH_REDIRECT_URI: 'http://staging.example.invalid/callback' },
    { META_EMBEDDED_SIGNUP_MESSAGE_ORIGINS: 'https://evil.example.invalid' },
    { META_EMBEDDED_SIGNUP_OPTIONS_JSON: JSON.stringify({ response_type: 'code', override_default_response_type: true, access_token: 'proibido' }) },
  ]) assert.equal(configuracaoWhatsappPublica({ ...envValido(), ...alteracao }).pronta, false);
});

test('prontidão do servidor exige segredo e chave AES válidos sem expô-los', () => {
  assert.equal(configuracaoWhatsappServidorPronta({ ...envValido(), META_APP_SECRET: '' }), false);
  assert.equal(configuracaoWhatsappServidorPronta({ ...envValido(), WHATSAPP_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(31).toString('base64') }), false);
});
