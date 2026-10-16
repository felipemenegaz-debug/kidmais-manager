import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHmac } from 'node:crypto';
import { MAX_BODY_BYTES, SIGNATURE_HEADER, assinaturaConfere, eventosMeta, receberWebhookMeta, verificarWebhookMeta, type EventosMeta, type ResumoMeta } from './webhook.ts';

const appSecret = 'synthetic-meta-app-secret-not-real-0001';
const verifyToken = 'synthetic-verify-token-not-real-0001';
const env = { META_APP_SECRET: appSecret, META_WEBHOOK_VERIFY_TOKEN: verifyToken, KIDMAIS_DEPLOY_ENV: 'staging' };
const URL_WEBHOOK = 'https://staging.example/api/integracoes/meta/webhook';

const mudanca = (value: unknown, field = 'messages') => ({ field, value });
const envelope = (...changes: unknown[]) => ({ object: 'whatsapp_business_account', entry: [{ id: '1555933295860010', changes }] });
const valor = (extra: Record<string, unknown>) => ({ messaging_product: 'whatsapp', metadata: { display_phone_number: '15550000000', phone_number_id: '1317246918141796' }, ...extra });
const texto = (body: unknown = 'Olá, quero orçamento', from = '5511900000001', id = 'wamid.SINTETICO1') => ({ from, id, timestamp: '1789550000', type: 'text', text: { body } });
const corpoPadrao = () => envelope(mudanca(valor({ contacts: [{ wa_id: '5511900000001', profile: { name: 'Cliente Sintético' } }], messages: [texto()] })));

const assinar = (corpo: string | Uint8Array, segredo = appSecret) => `sha256=${createHmac('sha256', segredo).update(corpo).digest('hex')}`;
function post(body: unknown = corpoPadrao(), headers: Record<string, string> = {}, url = URL_WEBHOOK) {
  const bruto = typeof body === 'string' ? body : JSON.stringify(body);
  return new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', [SIGNATURE_HEADER]: assinar(bruto), ...headers }, body: bruto });
}
const get = (q: Record<string, string>, url = URL_WEBHOOK) => new Request(`${url}?${new URLSearchParams(q)}`);
const verificacao = (extra: Record<string, string> = {}) => get({ 'hub.mode': 'subscribe', 'hub.verify_token': verifyToken, 'hub.challenge': '1158201444', ...extra });

test('GET: devolve o challenge só com o token exato, em https e ambiente conhecido', async () => {
  const ok = verificarWebhookMeta(verificacao(), env);
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), '1158201444');
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  assert.equal(verificarWebhookMeta(verificacao({ 'hub.verify_token': 'errado' }), env).status, 403);
  assert.equal(verificarWebhookMeta(verificacao({ 'hub.verify_token': `${verifyToken}x` }), env).status, 403);
  assert.equal(verificarWebhookMeta(verificacao({ 'hub.mode': 'unsubscribe' }), env).status, 403);
  assert.equal(verificarWebhookMeta(get({ 'hub.mode': 'subscribe', 'hub.challenge': '1' }), env).status, 403);
  for (const challenge of ['', '<script>', 'x'.repeat(129)]) assert.equal(verificarWebhookMeta(verificacao({ 'hub.challenge': challenge }), env).status, 400);
  assert.equal(verificarWebhookMeta(verificacao(), { ...env, META_WEBHOOK_VERIFY_TOKEN: '' }).status, 503);
  assert.equal(verificarWebhookMeta(verificacao(), { ...env, META_WEBHOOK_VERIFY_TOKEN: 'curto' }).status, 503);
  assert.equal(verificarWebhookMeta(verificacao(), { ...env, KIDMAIS_DEPLOY_ENV: 'local' }).status, 503);
  assert.equal(verificarWebhookMeta(new Request(verificacao().url.replace('https:', 'http:')), env).status, 403);
  // Atrás do Render vale o protocolo do proxy.
  assert.equal(verificarWebhookMeta(new Request(verificacao().url.replace('https:', 'http:'), { headers: { 'x-forwarded-proto': 'https' } }), { ...env, RENDER: 'true' }).status, 200);
  assert.equal(verificarWebhookMeta(verificacao(), { ...env, RENDER: 'true' }).status, 403);
});

test('assinatura: HMAC-SHA256 do corpo bruto; formato diferente recusa', () => {
  const corpo = Buffer.from('{"a":1}');
  assert.equal(assinaturaConfere(corpo, assinar(corpo), appSecret), true);
  assert.equal(assinaturaConfere(Buffer.from('{"a": 1}'), assinar(corpo), appSecret), false);
  assert.equal(assinaturaConfere(corpo, assinar(corpo, 'outro-segredo-sintetico-0002'), appSecret), false);
  for (const h of [null, '', assinar(corpo).slice(7), assinar(corpo).toUpperCase(), `sha1=${'0'.repeat(40)}`, `${assinar(corpo)} `]) assert.equal(assinaturaConfere(corpo, h, appSecret), false);
});

test('POST: guardas antes de ler eventos; assinatura inválida nunca persiste', async () => {
  const persistir = async () => assert.fail('não deve persistir');
  const recusa = async (req: Request, status: number, e: Record<string, string | undefined> = env) => assert.equal((await receberWebhookMeta(req, e, () => assert.fail('não deve registrar log'), persistir)).status, status);
  await recusa(post(corpoPadrao(), { [SIGNATURE_HEADER]: assinar('{}') }), 401);
  await recusa(post(corpoPadrao(), { [SIGNATURE_HEADER]: '' }), 401);
  await recusa(post(corpoPadrao(), { [SIGNATURE_HEADER]: assinar(JSON.stringify(corpoPadrao()), 'segredo-de-outro-app-00003') }), 401);
  await recusa(post(), 503, { ...env, META_APP_SECRET: '' });
  await recusa(post(), 503, { ...env, META_APP_SECRET: 'fraco' });
  await recusa(post(), 503, { ...env, KIDMAIS_DEPLOY_ENV: 'local' });
  await recusa(post(corpoPadrao(), {}, URL_WEBHOOK.replace('https:', 'http:')), 403);
  await recusa(post(corpoPadrao(), { 'content-type': 'text/plain' }), 415);
  await recusa(post(corpoPadrao(), { 'content-encoding': 'gzip' }), 415);
  await recusa(post({ ...corpoPadrao(), extra: 'x'.repeat(MAX_BODY_BYTES) }), 413);
  await recusa(post('{não é json'), 400);
  await recusa(post({ object: 'page', entry: [] }), 400);
  await recusa(new Request(URL_WEBHOOK, { method: 'PUT', body: '{}' }), 405);
});

test('POST: evento assinado é persistido e o log leva só contagens', async () => {
  const persistidos: EventosMeta[] = [], logs: ResumoMeta[] = [];
  const r = await receberWebhookMeta(post(), env, (l) => logs.push(l), async (e) => { persistidos.push(e); });
  assert.equal(r.status, 200);
  assert.deepEqual(persistidos, [{ entradas: [{ phoneNumberId: '1317246918141796', wabaId: '1555933295860010', id: 'wamid.SINTETICO1', contato: '5511900000001', texto: 'Olá, quero orçamento', timestamp: 1789550000000, nomePerfil: 'Cliente Sintético' }], status: [] }]);
  assert.deepEqual(logs, [{ entradas: 1, status: 0 }]);
  // Recepção desligada (sem persistir): confirma.
  assert.equal((await receberWebhookMeta(post(), env, () => {})).status, 200);
  // Sem eventos de atendimento (ex.: só status "sent" ou outro campo): não chama a persistência.
  const soSent = envelope(mudanca(valor({ statuses: [{ id: 'wamid.X', status: 'sent', recipient_id: '5511900000001' }] })), mudanca({ x: 1 }, 'account_update'));
  assert.equal((await receberWebhookMeta(post(soSent), env, () => {}, async () => assert.fail('nada a persistir'))).status, 200);
  // Falha que um retry corrige (banco): 503, sem log.
  assert.equal((await receberWebhookMeta(post(), env, () => assert.fail('sem log'), async () => { throw new Error('banco indisponível'); })).status, 503);
});

test('eventos: texto, sem texto, status e itens malformados ignorados um a um', () => {
  const e = eventosMeta(envelope(
    mudanca(valor({
      contacts: [{ wa_id: '5511900000002', profile: { name: 'Outro' } }, { wa_id: 'ruim' }],
      messages: [texto('  oi  '), texto('', '5511900000002', 'wamid.2'), texto('x'.repeat(4001), '5511900000002', 'wamid.3'),
        { from: '5511900000002', id: 'wamid.4', timestamp: '1789550001', type: 'image', image: { id: 'm1' } },
        { from: '+5511900000002', id: 'wamid.5', timestamp: '1789550001', type: 'text', text: { body: 'x' } },
        { from: '5511900000002', id: 'wamid.6', timestamp: 'agora', type: 'text', text: { body: 'x' } }, null, 'lixo'],
      statuses: [{ id: 'wamid.A', status: 'delivered' }, { id: 'wamid.B', status: 'read' }, { id: 'wamid.C', status: 'failed', errors: [{ code: 131047 }] }, { id: 'wamid.D', status: 'sent' }, { status: 'read' }],
    })),
    mudanca(valor({ messages: [texto()] }), 'message_template_status_update'),
    mudanca({ messaging_product: 'whatsapp', metadata: { phone_number_id: 'não numérico' }, messages: [texto()] }),
  ));
  assert.ok(e);
  assert.deepEqual(e.entradas.map((x) => [x.id, x.texto, x.nomePerfil ?? null]), [['wamid.SINTETICO1', 'oi', null], ['wamid.2', null, 'Outro'], ['wamid.3', null, 'Outro'], ['wamid.4', null, 'Outro']]);
  assert.deepEqual(e.status.map((s) => [s.id, s.tipo]), [['wamid.A', 'delivered'], ['wamid.B', 'read'], ['wamid.C', 'failed']]);
  assert.equal(eventosMeta({ object: 'whatsapp_business_account', entry: [] }), null);
  assert.equal(eventosMeta(null), null);
});
