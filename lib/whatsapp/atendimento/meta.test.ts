import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { cifrarCredencialWhatsapp } from '../credencial.ts';
import type { DbExecutor } from '../../db/contracts.ts';
import { conexaoEnvioMeta, enviarMensagemMeta, enviarPelaEmpresa, entradaMeta, mensagemMeta, persistenciaWebhookMeta } from './meta.ts';
import { canalEnvio, recepcaoMetaAtiva } from './configuracao.ts';
import { createHmac } from 'node:crypto';
import { receberWebhookMeta } from '../../integracoes/meta/webhook.ts';
import { APP_META } from './core.ts';

const EMPRESA = 'f0d2836a-2d70-46ec-a328-f7a9b896baad', OUTRA = '349aa3ae-f19d-4cc8-a06b-8ed4b2000c31';
const CHAVE = randomBytes(32).toString('base64');
Object.assign(process.env, { KIDMAIS_DEPLOY_ENV: 'staging', WHATSAPP_ATENDIMENTO_EMPRESA_ID: EMPRESA, META_GRAPH_API_VERSION: 'v23.0', WHATSAPP_CREDENTIAL_ENCRYPTION_KEY: CHAVE, WHATSAPP_CREDENTIAL_KEY_VERSION: '1' });
const TOKEN = 'EAAG-token-sintetico-nao-real';
const identidade = { ambiente: 'STAGING' as const, appId: '1622943079270352', businessId: '1591095999057604', wabaId: '1555933295860010', phoneNumberId: '1317246918141796', empresaId: EMPRESA };

function linha(over: Record<string, unknown> = {}, cifrarCom = identidade) {
  const c = cifrarCredencialWhatsapp(TOKEN, cifrarCom);
  return { id: 'c1', empresa_id: EMPRESA, meta_app_id: identidade.appId, business_id: identidade.businessId, waba_id: identidade.wabaId, phone_number_id: identidade.phoneNumberId,
    credencial_cifrada: c.ciphertext, credencial_iv: c.iv, credencial_tag: c.tag, credencial_chave_versao: c.keyVersion, token_expira_em: null, ...over };
}
function executor(rows: unknown[], consultas: unknown[][] = []): DbExecutor {
  return { query: async (sql: string, valores?: unknown[]) => { consultas.push([sql, valores]); return { rows, rowCount: rows.length }; } } as unknown as DbExecutor;
}
type Chamada = { url: string; init: RequestInit };
function rede(status: number, corpo: unknown, chamadas: Chamada[] = []): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => { chamadas.push({ url: String(url), init: init ?? {} }); return new Response(typeof corpo === 'string' ? corpo : JSON.stringify(corpo), { status }); }) as typeof fetch;
}
const ACEITA = { messaging_product: 'whatsapp', contacts: [{ input: '5511900000001', wa_id: '5511900000001' }], messages: [{ id: 'wamid.ENVIADA1' }] };
const conexao = { phoneNumberId: identidade.phoneNumberId, token: TOKEN };

test('corpo da Cloud API: texto sem prévia de link; mídia por link com legenda opcional', () => {
  const base = { messaging_product: 'whatsapp', recipient_type: 'individual', to: '5511900000001' };
  assert.deepEqual(mensagemMeta('5511900000001', { tipo: 'TEXTO', texto: 'Oi!' }), { ...base, type: 'text', text: { body: 'Oi!', preview_url: false } });
  assert.deepEqual(mensagemMeta('5511900000001', { tipo: 'IMAGEM', url: 'https://x.test/a.jpg', legenda: ' Salão ' }), { ...base, type: 'image', image: { link: 'https://x.test/a.jpg', caption: 'Salão' } });
  assert.deepEqual(mensagemMeta('5511900000001', { tipo: 'VIDEO', url: 'https://x.test/a.mp4', legenda: '  ' }), { ...base, type: 'video', video: { link: 'https://x.test/a.mp4' } });
  assert.deepEqual(mensagemMeta('5511900000001', { tipo: 'DOCUMENTO', url: 'https://x.test/c.pdf', nome: 'cardapio.pdf', legenda: null }), { ...base, type: 'document', document: { link: 'https://x.test/c.pdf', filename: 'cardapio.pdf' } });
});

test('envio: endpoint do número, Bearer, sem redirect; wamid devolvido', async () => {
  const chamadas: Chamada[] = [];
  assert.equal(await enviarMensagemMeta(conexao, '5511900000001', { tipo: 'TEXTO', texto: 'Oi!' }, rede(200, ACEITA, chamadas)), 'wamid.ENVIADA1');
  assert.equal(chamadas.length, 1);
  assert.equal(chamadas[0].url, 'https://graph.facebook.com/v23.0/1317246918141796/messages');
  assert.equal(chamadas[0].init.method, 'POST');
  assert.equal(chamadas[0].init.redirect, 'error');
  assert.equal((chamadas[0].init.headers as Record<string, string>).Authorization, `Bearer ${TOKEN}`);
  assert.equal(JSON.parse(String(chamadas[0].init.body)).to, '5511900000001');
});

test('envio: recusa definitiva = FALHOU; resposta estranha = INCERTO; configuração inválida não chama a rede', async () => {
  const msg = { tipo: 'TEXTO' as const, texto: 'Oi!' };
  for (const s of [400, 401, 403, 404, 429]) await assert.rejects(enviarMensagemMeta(conexao, '5511900000001', msg, rede(s, { error: { code: 131047 } })), /ATENDIMENTO_ENVIO_RECUSADO/);
  for (const [s, corpo] of [[500, {}], [200, {}], [200, { messages: [{}] }], [200, 'não é json'], [200, { messages: [{ id: 'x'.repeat(513) }] }], [200, { messages: [{ id: 'w' }], pad: 'x'.repeat(9000) }]] as const)
    await assert.rejects(enviarMensagemMeta(conexao, '5511900000001', msg, rede(s, corpo)), /ATENDIMENTO_RESULTADO_INCERTO/);
  const proibida = (() => assert.fail('rede não deve ser chamada')) as unknown as typeof fetch;
  await assert.rejects(enviarMensagemMeta(conexao, '+5511900000001', msg, proibida), /TRANSPORTE_NAO_CONFIGURADO/);
  await assert.rejects(enviarMensagemMeta({ ...conexao, token: '' }, '5511900000001', msg, proibida), /TRANSPORTE_NAO_CONFIGURADO/);
  await assert.rejects(enviarMensagemMeta(conexao, '5511900000001', { tipo: 'IMAGEM', url: 'http://x.test/a.jpg', legenda: null }, proibida), /TRANSPORTE_NAO_CONFIGURADO/);
  await assert.rejects(enviarMensagemMeta(conexao, '5511900000001', msg, proibida, { ...process.env, META_GRAPH_API_VERSION: 'latest' }), /TRANSPORTE_NAO_CONFIGURADO/);
});

test('credencial: conexão CONFIGURADA da empresa, decifrada com a identidade completa', async () => {
  const consultas: unknown[][] = [];
  assert.deepEqual(await conexaoEnvioMeta(executor([linha()], consultas), EMPRESA), conexao);
  assert.deepEqual(consultas[0][1], ['STAGING', EMPRESA]);
  assert.match(String(consultas[0][0]), /status='CONFIGURADA'/);
  assert.equal(await conexaoEnvioMeta(executor([]), EMPRESA), null);
  // Credencial cifrada para outra empresa (ou outro número) não abre: integridade.
  await assert.rejects(conexaoEnvioMeta(executor([linha({}, { ...identidade, empresaId: OUTRA })]), EMPRESA), /TRANSPORTE_NAO_CONFIGURADO/);
  await assert.rejects(conexaoEnvioMeta(executor([linha({ phone_number_id: '999' })]), EMPRESA), /TRANSPORTE_NAO_CONFIGURADO/);
  await assert.rejects(conexaoEnvioMeta(executor([linha({ credencial_chave_versao: 2 })]), EMPRESA), /TRANSPORTE_NAO_CONFIGURADO/);
  await assert.rejects(conexaoEnvioMeta(executor([linha({ token_expira_em: new Date(Date.now() - 1000).toISOString() })]), EMPRESA), /TRANSPORTE_NAO_CONFIGURADO/);
  assert.deepEqual(await conexaoEnvioMeta(executor([linha({ token_expira_em: new Date(Date.now() + 86_400_000).toISOString() })]), EMPRESA), conexao);
  await assert.rejects(conexaoEnvioMeta(executor([linha()]), EMPRESA, { ...process.env, WHATSAPP_CREDENTIAL_ENCRYPTION_KEY: '' }), /TRANSPORTE_NAO_CONFIGURADO/);
});

const MSG = { tipo: 'TEXTO' as const, texto: 'Oi!' };
const amb = (vars: Record<string, string>) => vars as unknown as NodeJS.ProcessEnv;
const gupshupProibido = async () => assert.fail('Gupshup não deve ser usado');
const comCanal = (valor: string | undefined) => { const env = { ...process.env }; if (valor === undefined) delete env.WHATSAPP_ATENDIMENTO_CANAL_ENVIO; else env.WHATSAPP_ATENDIMENTO_CANAL_ENVIO = valor; return env; };

test('canal de envio: só ausente/"gupshup" = GUPSHUP e "meta" = META; qualquer outro valor = INVALIDO', () => {
  assert.equal(canalEnvio(amb({})), 'GUPSHUP');
  assert.equal(canalEnvio(amb({ WHATSAPP_ATENDIMENTO_CANAL_ENVIO: 'gupshup' })), 'GUPSHUP');
  assert.equal(canalEnvio(amb({ WHATSAPP_ATENDIMENTO_CANAL_ENVIO: 'meta' })), 'META');
  for (const v of ['', 'Meta', 'META', 'gupshup ', ' meta', 'meta,gupshup', 'true', 'cloud']) assert.equal(canalEnvio(amb({ WHATSAPP_ATENDIMENTO_CANAL_ENVIO: v })), 'INVALIDO', JSON.stringify(v));
  assert.equal(recepcaoMetaAtiva(amb({})), false);
  for (const v of ['', 'TRUE', '1', 'sim', 'true ']) assert.equal(recepcaoMetaAtiva(amb({ WHATSAPP_ATENDIMENTO_RECEPCAO_META: v })), false, JSON.stringify(v));
  assert.equal(recepcaoMetaAtiva(amb({ WHATSAPP_ATENDIMENTO_RECEPCAO_META: 'true' })), true);
});

test('(1) chave ausente: a piloto CONECTADA à Meta continua enviando pelo Gupshup (a conexão não troca o canal)', async () => {
  for (const valor of [undefined, 'gupshup']) {
    const consultas: unknown[][] = [], chamadas: Chamada[] = [], viaGupshup: unknown[] = [];
    const id = await enviarPelaEmpresa('5511900000001', MSG, { env: comCanal(valor), executor: executor([linha()], consultas), buscar: rede(200, ACEITA, chamadas), gupshup: async (...a) => { viaGupshup.push(a[0]); return 'gs-1'; } });
    assert.equal(id, 'gs-1', String(valor));
    assert.deepEqual(viaGupshup, ['5511900000001']);
    assert.equal(chamadas.length, 0, 'nenhuma chamada à Meta');
    assert.equal(consultas.length, 0, 'nem lê a conexão Meta');
  }
});

test('canal "meta" com conexão válida: sai pela Cloud API da piloto, nunca pelo Gupshup', async () => {
  const chamadas: Chamada[] = [];
  assert.equal(await enviarPelaEmpresa('5511900000001', MSG, { env: comCanal('meta'), executor: executor([linha()]), buscar: rede(200, ACEITA, chamadas), gupshup: gupshupProibido }), 'wamid.ENVIADA1');
  assert.equal(chamadas[0].url, 'https://graph.facebook.com/v23.0/1317246918141796/messages');
});

test('(2) canal "meta" sem conexão válida falha antes da rede, sem cair no Gupshup', async () => {
  const casos: [string, DbExecutor][] = [
    ['sem conexão', executor([])],
    ['erro ao ler a conexão', { query: async () => { throw new Error('conexão recusada'); } } as unknown as DbExecutor],
    ['token vencido', executor([linha({ token_expira_em: new Date(Date.now() - 1000).toISOString() })])],
    ['credencial de outra empresa', executor([linha({}, { ...identidade, empresaId: OUTRA })])],
  ];
  for (const [rotulo, ex] of casos) {
    const chamadas: Chamada[] = [];
    await assert.rejects(enviarPelaEmpresa('5511900000001', MSG, { env: comCanal('meta'), executor: ex, buscar: rede(200, ACEITA, chamadas), gupshup: gupshupProibido }), /TRANSPORTE_NAO_CONFIGURADO/, rotulo);
    assert.equal(chamadas.length, 0, rotulo);
  }
});

test('(3) valor inválido do canal não envia por nenhum provedor nem lê a conexão', async () => {
  for (const valor of ['', 'Meta', 'gupshup ', 'cloud']) {
    const consultas: unknown[][] = [], chamadas: Chamada[] = [];
    await assert.rejects(enviarPelaEmpresa('5511900000001', MSG, { env: comCanal(valor), executor: executor([linha()], consultas), buscar: rede(200, ACEITA, chamadas), gupshup: gupshupProibido }), /TRANSPORTE_NAO_CONFIGURADO/, JSON.stringify(valor));
    assert.deepEqual([chamadas.length, consultas.length], [0, 0], JSON.stringify(valor));
  }
});

/** Recepção pelo webhook da Meta: a assinatura é conferida sempre; processar exige recepção do atendimento + chave própria. */
const SEGREDO = 'segredo-sintetico-app-meta-000001';
const RECEPCAO_LIGADA = amb({ KIDMAIS_DEPLOY_ENV: 'staging', WHATSAPP_ATENDIMENTO_RECEIVE_ENABLED: 'true', WHATSAPP_ATENDIMENTO_RECEPTOR: 'staging', WHATSAPP_ATENDIMENTO_EMPRESA_ID: EMPRESA });
const corpoMensagem = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: '2000000001', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: '3000000001' },
  messages: [{ from: '5561900002001', id: 'wamid.X', timestamp: '1789550000', type: 'text', text: { body: 'Oi' } }], statuses: [{ id: 'wamid.S', status: 'delivered' }] } }] }] });
const requisicao = (segredo = SEGREDO) => new Request('https://staging.example/api/integracoes/meta/webhook', { method: 'POST', body: corpoMensagem,
  headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${createHmac('sha256', segredo).update(corpoMensagem).digest('hex')}` } });
const ambienteWebhook = { META_APP_SECRET: SEGREDO, KIDMAIS_DEPLOY_ENV: 'staging' };

test('(4) recepção Meta desligada: assinatura conferida, 200, eventos descartados (não grava, não enfileira, não chama IA)', async () => {
  const desligadas: [string, NodeJS.ProcessEnv][] = [
    ['chave ausente com a recepção do atendimento ligada', RECEPCAO_LIGADA],
    ['chave com valor diferente de "true"', amb({ ...RECEPCAO_LIGADA, WHATSAPP_ATENDIMENTO_RECEPCAO_META: 'TRUE' })],
    ['chave ligada com a recepção do atendimento desligada', amb({ ...RECEPCAO_LIGADA, WHATSAPP_ATENDIMENTO_RECEIVE_ENABLED: 'false', WHATSAPP_ATENDIMENTO_RECEPCAO_META: 'true' })],
    ['chave ligada sem receptor deste ambiente', amb({ ...RECEPCAO_LIGADA, WHATSAPP_ATENDIMENTO_RECEPTOR: 'production', WHATSAPP_ATENDIMENTO_RECEPCAO_META: 'true' })],
  ];
  for (const [rotulo, env] of desligadas) {
    const recebidos: unknown[] = [];
    const persistir = persistenciaWebhookMeta({ automacaoGlobal: true }, env, async (e) => { recebidos.push(e); });
    assert.equal(persistir, undefined, rotulo);
    const resumos: unknown[] = [];
    assert.equal((await receberWebhookMeta(requisicao(), ambienteWebhook, (r) => resumos.push(r), persistir)).status, 200, rotulo);
    assert.deepEqual(resumos, [{ entradas: 1, status: 1 }], `${rotulo}: só a contagem`);
    assert.equal(recebidos.length, 0, `${rotulo}: nada processado`);
    assert.equal((await receberWebhookMeta(requisicao('segredo-de-outro-app-0000002'), ambienteWebhook, () => {}, persistir)).status, 401, `${rotulo}: assinatura inválida continua 401`);
  }
});

test('recepção Meta ligada: entrega mensagens E status ao processamento (isolamento e contatos ficam na recepção, ver PG)', async () => {
  const recebidos: { entradas: unknown[]; status: unknown[] }[] = [];
  const persistir = persistenciaWebhookMeta({ automacaoGlobal: false }, amb({ ...RECEPCAO_LIGADA, WHATSAPP_ATENDIMENTO_RECEPCAO_META: 'true' }), async (e, o) => { assert.deepEqual(o, { automacaoGlobal: false }); recebidos.push(e as never); });
  assert.equal(typeof persistir, 'function');
  assert.equal((await receberWebhookMeta(requisicao(), ambienteWebhook, () => {}, persistir)).status, 200);
  assert.equal(recebidos.length, 1);
  assert.deepEqual([recebidos[0].entradas.length, recebidos[0].status.length], [1, 1]);
  assert.equal((await receberWebhookMeta(requisicao('segredo-de-outro-app-0000002'), ambienteWebhook, () => {}, persistir)).status, 401);
  assert.equal(recebidos.length, 1, 'assinatura inválida não processa');
});

test('entrada: wa_id como contato, horário em ms, app da Meta e nome de perfil saneado', () => {
  assert.deepEqual(entradaMeta({ phoneNumberId: '1', wabaId: '2', id: 'wamid.1', contato: '5511900000001', texto: 'oi', timestamp: 1789550000000, nomePerfil: ' Ana\u0000  Maria ' }),
    { id: 'wamid.1', app: APP_META, source: '5511900000001', texto: 'oi', timestamp: 1789550000000, nomePerfil: 'Ana Maria' });
  assert.equal(entradaMeta({ phoneNumberId: '1', wabaId: '2', id: 'w', contato: '5511900000001', texto: null, timestamp: 1, nomePerfil: 42 }).nomePerfil, null);
});
