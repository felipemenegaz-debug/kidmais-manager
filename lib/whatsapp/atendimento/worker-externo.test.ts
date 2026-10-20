import assert from 'node:assert/strict';
import test from 'node:test';
// Worker externo (scripts/whatsapp-atendimento-worker.mjs): sem rede real; `buscar` é simulado.
import { ciclo, configuracaoWorker, esperaAposFalhas, executar } from '../../../scripts/whatsapp-atendimento-worker.mjs';

const URL_OK = 'https://staging.example.test/api/integracoes/gupshup/atendimento/processar';
const SEGREDO = 's'.repeat(40);
const env = (extra: Record<string, string | undefined> = {}) => ({ WHATSAPP_ATENDIMENTO_WORKER_URL: URL_OK, WHATSAPP_ATENDIMENTO_WORKER_SECRET: SEGREDO, ...extra });

test('worker externo só inicia com a URL HTTPS completa do processador e segredo válido', () => {
  assert.deepEqual(configuracaoWorker(env()), { url: URL_OK, secret: SEGREDO });
  for (const url of ['http://staging.example.test/api/integracoes/gupshup/atendimento/processar', 'https://staging.example.test/', 'https://staging.example.test/api/integracoes/gupshup/atendimento/processar?segredo=x', 'https://u:p@staging.example.test/api/integracoes/gupshup/atendimento/processar', 'não é url', undefined])
    assert.throws(() => configuracaoWorker(env({ WHATSAPP_ATENDIMENTO_WORKER_URL: url })), /WORKER_URL/, String(url));
  for (const secret of ['curto', 'com espaço'.padEnd(40, 'x'), undefined]) assert.throws(() => configuracaoWorker(env({ WHATSAPP_ATENDIMENTO_WORKER_SECRET: secret })), /WORKER_SECRET/);
  // A mensagem de erro nunca ecoa o segredo.
  try { configuracaoWorker(env({ WHATSAPP_ATENDIMENTO_WORKER_URL: 'http://x', WHATSAPP_ATENDIMENTO_WORKER_SECRET: SEGREDO })); } catch (e) { assert.doesNotMatch(String(e), new RegExp(SEGREDO)); }
});

test('espera cresce com falhas seguidas até 60 s e volta ao normal no sucesso', async () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 10].map(esperaAposFalhas), [3000, 6000, 12000, 24000, 48000, 60000, 60000]);
  const logs: string[] = [];
  const config = configuracaoWorker(env());
  const r503 = await ciclo(config, (async () => new Response(null, { status: 503 })) as typeof fetch, 2, (m: string) => logs.push(m));
  assert.deepEqual(r503, { espera: 12000, falhas: 3, tarefas: 0 });
  const r401 = await ciclo(config, (async () => new Response(null, { status: 401 })) as typeof fetch, 0, (m: string) => logs.push(m));
  assert.equal(r401.falhas, 1); assert.match(logs.at(-1)!, /recusou o worker \(401\)/);
  const rede = await ciclo(config, (async () => { throw new TypeError('fetch failed'); }) as typeof fetch, 0, (m: string) => logs.push(m));
  assert.equal(rede.espera, 3000);
  const limite = await ciclo(config, (async () => Response.json({ estado: 'LIMITE', tarefas: 20 })) as typeof fetch, 5, (m: string) => logs.push(m));
  assert.deepEqual(limite, { espera: 0, falhas: 0, tarefas: 20, estado: 'LIMITE' }, 'fila cheia: chama de novo sem esperar');
  const vazio = await ciclo(config, (async () => Response.json({ estado: 'SEM_TAREFA', tarefas: 0 })) as typeof fetch, 0, (m: string) => logs.push(m));
  assert.equal(vazio.espera, 3000);
  assert.ok(logs.every(l => !l.includes(SEGREDO)), 'logs sem segredo');
});

test('worker envia o segredo só no cabeçalho, sem seguir redirect, e para quando recebe o sinal', async () => {
  const controle = new AbortController();
  const chamadas: { url: string; init?: RequestInit }[] = [];
  const buscar = (async (url: string, init?: RequestInit) => {
    chamadas.push({ url, init });
    if (chamadas.length === 3) controle.abort();
    return Response.json({ estado: 'LIMITE', tarefas: 1 });
  }) as unknown as typeof fetch;
  const infos: string[] = [];
  await executar({ env: env() as unknown as NodeJS.ProcessEnv, buscar, log: () => {}, info: (m: string) => infos.push(m), sinal: controle.signal });
  assert.equal(chamadas.length, 3);
  for (const c of chamadas) {
    assert.equal(c.url, URL_OK); assert.equal(c.init?.method, 'POST'); assert.equal(c.init?.redirect, 'error');
    assert.equal((c.init?.headers as Record<string, string>)['x-kidmais-worker-secret'], SEGREDO);
  }
  assert.deepEqual(infos, ['Atendimento: worker iniciado.', 'Atendimento: processador LIMITE.', 'Atendimento: worker encerrado.']);
});
