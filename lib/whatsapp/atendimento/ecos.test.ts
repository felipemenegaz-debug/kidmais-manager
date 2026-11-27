import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, createHmac } from 'node:crypto';
import { SIGNATURE_HEADER, eventosMeta, receberWebhookMeta, type EventosMeta, type ResumoMeta } from '../../integracoes/meta/webhook.ts';
import { DESVIO_FUTURO_MS, JANELA_ECO_DIAS, MARGEM_CORTE_MS, hashCorte, hashEco, receberEco } from './service.ts';
import { JANELA_REENTREGA_DIAS } from './core.ts';
import { RETENCAO_DEDUP_DIAS } from './privacidade.ts';
import { ecosMetaAtivos } from './configuracao.ts';

/**
 * Ecos do app WhatsApp Business (F1): parser do campo `smb_message_echoes`, handler do webhook e as contas fixas
 * (janela × retenção × margem do corte, hashes). O comportamento no banco está em ecos.postgres.test.ts.
 */
const NUMERO = '1317246918141796', WABA = '1555933295860010', CONTATO = '5511900000001', PROPRIO = '5561999990000';
const ENV = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv;
const ecoItem = (over: Record<string, unknown> = {}) => ({ from: PROPRIO, to: CONTATO, id: 'wamid.ECO1', timestamp: '1789550000', type: 'text', text: { body: ' Pode sim, às 15h ' }, ...over });
const valorEco = (ecos: unknown[], extra: Record<string, unknown> = {}) => ({ messaging_product: 'whatsapp', metadata: { display_phone_number: '15550000000', phone_number_id: NUMERO }, message_echoes: ecos, ...extra });
const envelope = (...changes: unknown[]) => ({ object: 'whatsapp_business_account', entry: [{ id: WABA, changes }] });
const mudanca = (value: unknown, field = 'smb_message_echoes') => ({ field, value });

test('parser: envelope v26 de smb_message_echoes vira eco com contato = destinatário (to), nunca o remetente (from)', () => {
  const e = eventosMeta(envelope(mudanca(valorEco([ecoItem()]))));
  assert.deepEqual(e, { entradas: [], status: [], ecos: [{ phoneNumberId: NUMERO, wabaId: WABA, id: 'wamid.ECO1', contato: CONTATO, texto: 'Pode sim, às 15h', timestamp: 1789550000000 }] });
  // `from` ausente ou fora do formato não importa (é o próprio número); `to` é obrigatório e validado.
  assert.equal(eventosMeta(envelope(mudanca(valorEco([ecoItem({ from: undefined })]))))!.ecos[0].contato, CONTATO);
  assert.equal(eventosMeta(envelope(mudanca(valorEco([ecoItem({ from: 'x' })]))))!.ecos[0].contato, CONTATO);
  for (const to of [undefined, '', '+5511900000001', '1234567', '1234567890123456', 'abc']) assert.deepEqual(eventosMeta(envelope(mudanca(valorEco([ecoItem({ to })]))))!.ecos, [], `to=${to}`);
});

test('parser: mídia, figurinha, localização, texto vazio ou longo = conteúdo sem texto (texto null)', () => {
  const textos = (itens: unknown[]) => eventosMeta(envelope(mudanca(valorEco(itens))))!.ecos.map((e) => e.texto);
  assert.deepEqual(textos([
    ecoItem({ id: 'a', type: 'image', text: undefined, image: { id: '1' } }),
    ecoItem({ id: 'b', type: 'sticker', text: undefined }),
    ecoItem({ id: 'c', type: 'location', text: undefined }),
    ecoItem({ id: 'd', text: { body: '   ' } }),
    ecoItem({ id: 'e', text: { body: 'x'.repeat(4001) } }),
    ecoItem({ id: 'f', text: { body: 42 } }),
    ecoItem({ id: 'g', text: { body: 'x'.repeat(4000) } }),
  ]), [null, null, null, null, null, null, 'x'.repeat(4000)]);
});

test('parser: item malformado não derruba os outros; lote misto com messages; campo desconhecido ignorado', () => {
  const corpo = { object: 'whatsapp_business_account', entry: [{ id: WABA, changes: [
    mudanca(valorEco([ecoItem({ id: '' }), 'lixo', ecoItem({ timestamp: 'ontem' }), ecoItem({ id: 'wamid.BOM' })])),
    mudanca({ messaging_product: 'whatsapp', metadata: { phone_number_id: NUMERO }, messages: [{ from: CONTATO, id: 'wamid.IN', timestamp: '1789550000', type: 'text', text: { body: 'oi' } }] }, 'messages'),
    mudanca(valorEco([ecoItem({ id: 'wamid.OUTRO' })]), 'message_template_status_update'),
    mudanca({ messaging_product: 'whatsapp', metadata: { phone_number_id: 'x' }, message_echoes: [ecoItem({ id: 'wamid.SEMNUMERO' })] }),
  ] }] };
  const e = eventosMeta(corpo)!;
  assert.deepEqual(e.ecos.map((x) => x.id), ['wamid.BOM']);
  assert.deepEqual(e.entradas.map((x) => x.id), ['wamid.IN']);
  assert.deepEqual(e.status, []);
  // Um eco nunca vira entrada (nem uma entrada vira eco), mesmo com o mesmo formato de item.
  assert.equal(eventosMeta(envelope(mudanca(valorEco([ecoItem()]), 'messages')))!.ecos.length, 0);
  assert.equal(eventosMeta(envelope(mudanca(valorEco([ecoItem()]), 'messages')))!.entradas.length, 0);
});

const appSecret = 'synthetic-meta-app-secret-not-real-0001';
const env = { META_APP_SECRET: appSecret, KIDMAIS_DEPLOY_ENV: 'staging' };
function post(body: unknown) {
  const bruto = JSON.stringify(body);
  return new Request('https://staging.example/api/integracoes/meta/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', [SIGNATURE_HEADER]: 'sha256=' + createHmac('sha256', appSecret).update(bruto).digest('hex') }, body: bruto });
}

test('handler: POST só com ecos chama persistir; falha da persistência = 503 (a Meta repete); log só com contagens', async () => {
  const persistidos: EventosMeta[] = [], logs: ResumoMeta[] = [];
  const r = await receberWebhookMeta(post(envelope(mudanca(valorEco([ecoItem()])))), env, (l) => logs.push(l), async (e) => { persistidos.push(e); });
  assert.equal(r.status, 200);
  assert.equal(persistidos.length, 1);
  assert.equal(persistidos[0].ecos!.length, 1);
  assert.deepEqual(logs, [{ entradas: 0, status: 0, ecos: 1 }]);
  const falha = await receberWebhookMeta(post(envelope(mudanca(valorEco([ecoItem()])))), env, () => assert.fail('sem log na falha'), async () => { throw new Error('banco fora'); });
  assert.equal(falha.status, 503);
  // Lote sem nenhum evento útil não chama persistir.
  const vazio = await receberWebhookMeta(post(envelope(mudanca(valorEco([ecoItem({ to: 'x' })])))), env, () => {}, async () => assert.fail('não persiste lote vazio'));
  assert.equal(vazio.status, 200);
});

test('contas fixas: janela do eco + margem do corte cabem na retenção dos hashes (R5-1/R6)', () => {
  assert.equal(JANELA_ECO_DIAS, JANELA_REENTREGA_DIAS - 1);
  assert.equal(JANELA_ECO_DIAS, 29);
  assert.equal(RETENCAO_DEDUP_DIAS, 30);
  assert.equal(MARGEM_CORTE_MS, 2000);
  assert.ok(JANELA_ECO_DIAS * 86_400_000 + MARGEM_CORTE_MS < RETENCAO_DEDUP_DIAS * 86_400_000);
});

test('hashes: eco: e corte: com prefixo e UTF-8 (iguais à expressão SQL; conferido também no PG)', () => {
  const sha = (s: string) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
  assert.equal(hashEco('wamid.ÉCO'), sha('eco:wamid.ÉCO'));
  assert.equal(hashCorte(CONTATO), sha('corte:' + CONTATO));
  assert.notEqual(hashEco(CONTATO), hashCorte(CONTATO));
  assert.match(hashEco('x'), /^[0-9a-f]{64}$/);
});

test('chave própria: só "true" liga; desligada, receberEco descarta sem abrir transação', async () => {
  assert.equal(ecosMetaAtivos(ENV({})), false);
  for (const v of ['1', 'TRUE', 'yes', ' true']) assert.equal(ecosMetaAtivos(ENV({ WHATSAPP_ATENDIMENTO_ECOS_META: v })), false, v);
  assert.equal(ecosMetaAtivos(ENV({ WHATSAPP_ATENDIMENTO_ECOS_META: 'true' })), true);
  // Sem DATABASE_URL: se abrisse transação, rejeitaria. Desligada = NADA.
  assert.equal(await receberEco({ id: 'wamid.X', contato: CONTATO, texto: 'oi', timestamp: Date.now() }, { empresa: 'f0d2836a-2d70-46ec-a328-f7a9b896baad', env: ENV({}) }), 'NADA');
});

test('R1-4: U+0000 no id descarta o eco; no corpo vira texto nulo; o eco válido seguinte do lote segue', () => {
  const e = eventosMeta(envelope(mudanca(valorEco([
    ecoItem({ id: 'wamid.NU\u0000LO' }),
    ecoItem({ id: 'wamid.CORPO', text: { body: 'a\u0000b' } }),
    ecoItem({ id: 'wamid.BOM' }),
  ]))))!;
  assert.deepEqual(e.ecos.map((x) => [x.id, x.texto]), [['wamid.CORPO', null], ['wamid.BOM', 'Pode sim, às 15h']]);
});

test('R1-1/R1-4: sem número, número inválido ou id com U+0000, receberEco descarta sem abrir transação', async () => {
  const ligada = ENV({ WHATSAPP_ATENDIMENTO_ECOS_META: 'true' }), empresa = 'f0d2836a-2d70-46ec-a328-f7a9b896baad';
  const eco = { id: 'wamid.X', contato: CONTATO, texto: 'oi', timestamp: Date.now() };
  assert.equal(await receberEco(eco, { empresa, env: ligada }), 'NADA');
  assert.equal(await receberEco(eco, { empresa, numero: { phoneNumberId: 'x', wabaId: WABA }, env: ligada }), 'NADA');
  assert.equal(await receberEco(eco, { empresa, numero: { phoneNumberId: NUMERO, wabaId: '' }, env: ligada }), 'NADA');
  assert.equal(await receberEco({ ...eco, id: 'wamid.\u0000' }, { empresa, numero: { phoneNumberId: NUMERO, wabaId: WABA }, env: ligada }), 'NADA');
});

test('R1-2: o desvio futuro admitido não passa da margem do corte', () => {
  assert.ok(DESVIO_FUTURO_MS > 0 && DESVIO_FUTURO_MS <= MARGEM_CORTE_MS);
});

test('R1-4: lote misto (eco com U+0000 no id, eco com U+0000 no corpo, eco válido e status) → 200 e o status chega à persistência', async () => {
  const persistidos: EventosMeta[] = [];
  const corpo = { object: 'whatsapp_business_account', entry: [{ id: WABA, changes: [
    mudanca(valorEco([ecoItem({ id: 'wamid.NU\u0000LO' }), ecoItem({ id: 'wamid.CORPO', text: { body: 'a\u0000b' } }), ecoItem({ id: 'wamid.BOM' })])),
    mudanca({ messaging_product: 'whatsapp', metadata: { phone_number_id: NUMERO }, statuses: [{ id: 'wamid.S', status: 'delivered' }] }, 'messages'),
  ] }] };
  const r = await receberWebhookMeta(post(corpo), env, () => {}, async (e) => { persistidos.push(e); });
  assert.equal(r.status, 200);
  assert.deepEqual(persistidos[0].ecos!.map((x) => [x.id, x.texto]), [['wamid.CORPO', null], ['wamid.BOM', 'Pode sim, às 15h']]);
  assert.deepEqual(persistidos[0].status.map((s) => [s.id, s.tipo]), [['wamid.S', 'delivered']]);
});
