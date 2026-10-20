import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { receiveGupshupWebhook, SECRET_HEADER } from './webhook.ts';

/**
 * Preservação do fluxo OTP (12/10/2026). O webhook da Gupshup é COMPARTILHADO entre o OTP/identidade e o atendimento: a
 * candidata acrescentou ao receptor um parâmetro opcional (persistEvent) e, na rota, só o passa com a recepção do
 * atendimento ligada. Prova: sem ele, o comportamento é o do staging (ACK 204 e log sanitizado; nada persistido); com ele,
 * o handshake (user-event) e eventos sem segredo nunca são persistidos; uma falha da persistência devolve 503 (o provedor
 * repete o evento) — só com a recepção ligada, e só para eventos de mensagem/status. O OTP não lê o webhook (envia pela API
 * e confere o código no banco), então esse 503 não bloqueia login, apenas atrasa o registro do status.
 */
const secret = 'synthetic-webhook-test-secret-not-real-123';
const env = { GUPSHUP_WEBHOOK_SECRET: secret, KIDMAIS_DEPLOY_ENV: 'staging' };
const pedido = (corpo: unknown, comSegredo = true) => new Request('https://staging.example/api/integracoes/gupshup/webhook', {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...(comSegredo ? { [SECRET_HEADER]: secret } : {}) }, body: JSON.stringify(corpo),
});
const statusOtp = (tipo = 'delivered') => ({ app: 'KidmaisManager', timestamp: 1789550000000, version: 2, type: 'message-event', payload: { id: 'otp-synthetic-id', type: tipo, destination: '5511999990000', payload: {} } });
const handshake = { app: 'KidmaisManager', timestamp: 1789603200000, version: 2, type: 'user-event', payload: { type: 'sandbox-start', phone: '5511999990000' } };

test('OTP: sem a recepção do atendimento (persistEvent ausente) nada muda — 204, log sanitizado, nada persistido', async () => {
  for (const tipo of ['sent', 'delivered', 'read', 'failed']) {
    const logs: unknown[] = [];
    const r = await receiveGupshupWebhook(pedido(statusOtp(tipo)), env, (e) => logs.push(e));
    assert.equal(r.status, 204, tipo); assert.equal(logs.length, 1);
  }
  assert.equal((await receiveGupshupWebhook(pedido(handshake, false), env, () => {})).status, 204, 'handshake sem segredo continua aceito');
  assert.equal((await receiveGupshupWebhook(pedido(statusOtp(), false), env, () => assert.fail('sem log'))).status, 401, 'status sem segredo continua recusado');
});
test('OTP: com a recepção ligada, só eventos autenticados de mensagem/status são persistidos; handshake nunca', async () => {
  const persistidos: unknown[] = [];
  const persistir = async (raw: unknown) => { persistidos.push(raw); };
  assert.equal((await receiveGupshupWebhook(pedido(handshake, false), env, () => {}, persistir)).status, 204);
  assert.equal((await receiveGupshupWebhook(pedido(statusOtp(), false), env, () => {}, persistir)).status, 401);
  assert.equal(persistidos.length, 0, 'handshake e evento sem segredo nunca chegam à persistência');
  assert.equal((await receiveGupshupWebhook(pedido(statusOtp()), env, () => {}, persistir)).status, 204);
  assert.equal(persistidos.length, 1);
  const falha = await receiveGupshupWebhook(pedido(statusOtp()), env, () => assert.fail('falha não registra log de sucesso'), async () => { throw new Error('banco indisponível'); });
  assert.equal(falha.status, 503, 'falha da persistência: o provedor repete (limite documentado)');
});
test('OTP: a rota só monta a persistência do atendimento com a recepção ligada; o remetente do OTP não foi alterado', () => {
  const rota = readFileSync(new URL('../../../app/api/integracoes/gupshup/webhook/route.ts', import.meta.url), 'utf8');
  assert.match(rota, /\}, recepcaoAtiva\(\) \? async \(raw, event\) => \{/);
  assert.match(rota, /\} : undefined\);/);
});
