import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { cifrarCredencialWhatsapp } from '../credencial.ts';
import type { DbExecutor } from '../../db/contracts.ts';
import { conexaoEnvioMeta, enviarMensagemMeta, enviarPelaEmpresa, entradaMeta, mensagemMeta } from './meta.ts';
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

test('porta do worker: com conexão sai pela Meta; sem conexão, pelo Gupshup; erro ao ler a conexão não chama rede', async () => {
  const msg = { tipo: 'TEXTO' as const, texto: 'Oi!' };
  const chamadas: Chamada[] = [];
  const gupshupProibido = async () => assert.fail('Gupshup não deve ser usado');
  assert.equal(await enviarPelaEmpresa('5511900000001', msg, { executor: executor([linha()]), buscar: rede(200, ACEITA, chamadas), gupshup: gupshupProibido }), 'wamid.ENVIADA1');
  assert.equal(chamadas[0].url, 'https://graph.facebook.com/v23.0/1317246918141796/messages');
  const viaGupshup: unknown[] = [];
  assert.equal(await enviarPelaEmpresa('5511900000001', msg, { executor: executor([]), gupshup: async (...a) => { viaGupshup.push(a[0]); return 'gs-1'; } }), 'gs-1');
  assert.deepEqual(viaGupshup, ['5511900000001']);
  const falha = { query: async () => { throw new Error('conexão recusada'); } } as unknown as DbExecutor;
  await assert.rejects(enviarPelaEmpresa('5511900000001', msg, { executor: falha, gupshup: gupshupProibido }), /TRANSPORTE_NAO_CONFIGURADO/);
});

test('entrada: wa_id como contato, horário em ms, app da Meta e nome de perfil saneado', () => {
  assert.deepEqual(entradaMeta({ phoneNumberId: '1', wabaId: '2', id: 'wamid.1', contato: '5511900000001', texto: 'oi', timestamp: 1789550000000, nomePerfil: ' Ana\u0000  Maria ' }),
    { id: 'wamid.1', app: APP_META, source: '5511900000001', texto: 'oi', timestamp: 1789550000000, nomePerfil: 'Ana Maria' });
  assert.equal(entradaMeta({ phoneNumberId: '1', wabaId: '2', id: 'w', contato: '5511900000001', texto: null, timestamp: 1, nomePerfil: 42 }).nomePerfil, null);
});
