import assert from 'node:assert/strict';
import test from 'node:test';
import { trocarCodigoEValidarAtivos } from './meta-client.ts';
import { exigirConfiguracaoWhatsappPrivada } from './configuracao.ts';

const config = exigirConfiguracaoWhatsappPrivada({
  KIDMAIS_DEPLOY_ENV: 'staging', META_APP_ID: '1', META_APP_SECRET: 'segredo-sintetico-valido',
  META_GRAPH_API_VERSION: 'v24.0', META_EMBEDDED_SIGNUP_CONFIG_ID: '2',
  META_OAUTH_REDIRECT_URI: 'https://staging.example.invalid/callback',
  META_EMBEDDED_SIGNUP_OPTIONS_JSON: '{"response_type":"code","override_default_response_type":true}',
  META_EMBEDDED_SIGNUP_EVENT_NAME: 'FINISH', META_EMBEDDED_SIGNUP_MESSAGE_ORIGINS: 'https://www.facebook.com',
});

test('troca código no servidor e confronta app, escopos, WABA, número e coexistência', async () => {
  const urls: string[] = [];
  const fetchMock = async (input: string | URL | Request) => {
    const url = String(input); urls.push(url);
    const body = url.includes('/oauth/access_token') ? { access_token: 'token-sintetico', token_type: 'bearer', expires_in: 3600 }
      : url.includes('/debug_token') ? { data: { is_valid: true, app_id: '1', scopes: ['whatsapp_business_management', 'whatsapp_business_messaging'] } }
        : url.includes('/10/client_whatsapp_business_accounts') ? { data: [{ id: '20' }] }
          : { data: [{ id: '30', display_phone_number: '+55 11 0000-0000', verified_name: 'Demo', is_on_biz_app: true }] };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const result = await trocarCodigoEValidarAtivos({ code: 'codigo-sintetico', businessId: '10', wabaId: '20', phoneNumberId: '30' }, config, fetchMock as typeof fetch);
  assert.equal(result.accessToken, 'token-sintetico'); assert.equal(result.verifiedName, 'Demo');
  assert.equal(urls.length, 4);
});

test('coexistência não confirmada é recusada', async () => {
  let chamada = 0;
  const respostas = [
    { access_token: 'token-sintetico' },
    { data: { is_valid: true, app_id: '1', scopes: ['whatsapp_business_management', 'whatsapp_business_messaging'] } },
    { data: [{ id: '20' }] },
    { data: [{ id: '30', display_phone_number: '+55', verified_name: 'Demo', is_on_biz_app: false }] },
  ];
  const fetchMock = async () => new Response(JSON.stringify(respostas[chamada++]), { status: 200 });
  await assert.rejects(trocarCodigoEValidarAtivos({ code: 'codigo-sintetico', businessId: '10', wabaId: '20', phoneNumberId: '30' }, config, fetchMock as typeof fetch), /coexistência/);
});
