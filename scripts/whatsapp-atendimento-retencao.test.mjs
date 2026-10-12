import assert from 'node:assert/strict';
import test from 'node:test';
import { configuracaoRetencao, executarUmaVez } from './whatsapp-atendimento-retencao.mjs';

// Disparo da retenção (D2, 12/10/2026): URL HTTPS exata e segredo válidos; resumo sem dados; falha vira erro sem dados.
const SEGREDO = 'x'.repeat(40);
const URL_OK = 'https://staging.example/api/integracoes/gupshup/atendimento/retencao';

test('configuração: só a URL HTTPS exata da rota e o segredo do worker', () => {
  assert.deepEqual(configuracaoRetencao({ WHATSAPP_ATENDIMENTO_RETENCAO_URL: URL_OK, WHATSAPP_ATENDIMENTO_WORKER_SECRET: SEGREDO }), { url: URL_OK, secret: SEGREDO });
  for (const url of [undefined, 'http://staging.example/api/integracoes/gupshup/atendimento/retencao', 'https://staging.example/api/integracoes/gupshup/atendimento/processar', `${URL_OK}?x=1`, 'https://u:p@staging.example/api/integracoes/gupshup/atendimento/retencao'])
    assert.throws(() => configuracaoRetencao({ WHATSAPP_ATENDIMENTO_RETENCAO_URL: url, WHATSAPP_ATENDIMENTO_WORKER_SECRET: SEGREDO }), /RETENCAO_URL/);
  assert.throws(() => configuracaoRetencao({ WHATSAPP_ATENDIMENTO_RETENCAO_URL: URL_OK, WHATSAPP_ATENDIMENTO_WORKER_SECRET: 'curto' }), /WORKER_SECRET/);
});
test('execução: segredo no cabeçalho, resumo só com estado, contagens e códigos', async () => {
  let chamada;
  const buscar = async (url, init) => { chamada = { url, init }; return new Response(JSON.stringify({ estado: 'CONCLUIDA_COM_FALHAS', empresas: 2, excluidas: 3, adiadas: 1, falhas: 1, pendentes: 2, dedup: 4, erros: ['SQLSTATE_40P01', 'texto livre com dado'] }), { status: 200 }); };
  const r = await executarUmaVez({ env: { WHATSAPP_ATENDIMENTO_RETENCAO_URL: URL_OK, WHATSAPP_ATENDIMENTO_WORKER_SECRET: SEGREDO }, buscar });
  assert.equal(chamada.init.headers['x-kidmais-worker-secret'], SEGREDO); assert.equal(chamada.init.method, 'POST');
  assert.deepEqual(r, { estado: 'CONCLUIDA_COM_FALHAS', empresas: 2, excluidas: 3, adiadas: 1, falhas: 1, pendentes: 2, dedup: 4, erros: ['SQLSTATE_40P01'] });
  await assert.rejects(executarUmaVez({ env: { WHATSAPP_ATENDIMENTO_RETENCAO_URL: URL_OK, WHATSAPP_ATENDIMENTO_WORKER_SECRET: SEGREDO }, buscar: async () => new Response(null, { status: 401 }) }), /\(401\)/);
});
