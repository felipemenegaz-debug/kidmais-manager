import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import ts from 'typescript';
import { z } from 'zod';

const requireLocal = createRequire(import.meta.url);
const contratoId = '00000000-0000-4000-8000-000000000001';
const context = () => ({ params: Promise.resolve({ contratoId }) });
type Post = (request: Request, routeContext: ReturnType<typeof context>) => Promise<Response>;

function ambiente() {
  const logs: unknown[][] = [];
  const calls: { service: unknown[][]; provider: number } = { service: [], provider: 0 };
  const safeConsole = Object.fromEntries(['debug', 'info', 'warn', 'error', 'log', 'trace']
    .map(method => [method, (...args: unknown[]) => logs.push(args)]));
  const next = requireLocal('next/server');
  const sender = async () => { calls.provider++; };
  const services = {
    isContratoServiceError: () => false,
    iniciarDesafioContrato: async (...args: unknown[]) => {
      // This is the boundary before any OTP generation, persistence or delivery.
      calls.service.push(args);
      return { validacaoId: 'synthetic-challenge', destinoMascarado: '***88' };
    },
  };
  function carregar(file: URL, dependencies: Record<string, unknown>) {
    const exports: Record<string, unknown> = {};
    const code = ts.transpileModule(readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    new Function('require', 'exports', 'console', code)((name: string) => {
      // No real service, provider or database module may be loaded by this test.
      assert.ok(Object.hasOwn(dependencies, name), 'Unexpected dependency');
      return dependencies[name];
    }, exports, safeConsole);
    return exports;
  }
  const utils = carregar(new URL('./route-utils.ts', import.meta.url), {
    'next/server': next,
    '@/lib/contratos/services': services,
    '@/lib/identidade/services': { isIdentityServiceError: () => false },
    '@/lib/festas/domain': { FestaError: class extends Error {} },
  });
  const route = carregar(new URL('./[contratoId]/identidade/iniciar/route.ts', import.meta.url), {
    'next/server': next, zod: { z },
    '@/lib/contratos/services': services,
    '@/lib/identidade/delivery': { enviarOtpComAmbiente: sender },
    '../../../route-utils': utils,
  });
  return { post: route.POST as Post, logs, calls, sender };
}

const request = (body: string) => new Request('https://local.example/api/contratos/test/identidade/iniciar', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
});
const invalidJson = { ok: false, erro: 'Corpo JSON inválido.', codigo: 'JSON_INVALIDO' };

test('JSON inválido retorna 400 estável sem logs, provider, geração ou persistência de OTP', async () => {
  for (const body of ['', 'otp=123456', '+5511999998888', 'sk_synthetic_private_credential',
    '{"otp":"123456","phone":"5511999998888","secret":"synthetic-secret",']) {
    const a = ambiente();
    const response = await a.post(request(body), context());
    assert.equal(response.status, 400);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.deepEqual(await response.json(), invalidJson);
    assert.deepEqual(a.calls.service, []);
    assert.equal(a.calls.provider, 0);
    assert.deepEqual(a.logs, []);
  }
});

test('erro de leitura de JSON com causa sensível não chega ao logger nem à resposta', async () => {
  const a = ambiente();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new Error('OTP=123456 phone=5511999998888 apikey=sk_synthetic_private', {
        cause: { body: 'synthetic-raw-body', cookie: 'synthetic-secret' },
      }));
    },
  });
  const init: RequestInit & { duplex: string } = { method: 'POST', body, duplex: 'half' };
  const response = await a.post(new Request('https://local.example/identity', init), context());
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), invalidJson);
  assert.deepEqual(a.calls.service, []);
  assert.equal(a.calls.provider, 0);
  assert.deepEqual(a.logs, []);
});

test('JSON válido com schema inválido mantém DADOS_INVALIDOS e não inicia OTP', async () => {
  const a = ambiente();
  const response = await a.post(request('{"cpf":"test","canal":"EMAIL"}'), context());
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { ok: false, erro: 'Dados inválidos.', codigo: 'DADOS_INVALIDOS' });
  assert.deepEqual(a.calls.service, []);
  assert.equal(a.calls.provider, 0);
  assert.deepEqual(a.logs, []);
});

test('requisição válida preserva encaminhamento ao serviço, emissor e resposta 201', async () => {
  const a = ambiente();
  const input = { cpf: '12345678909', canal: 'WHATSAPP' };
  const response = await a.post(request(JSON.stringify(input)), context());
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await response.json(), {
    ok: true, data: { validacaoId: 'synthetic-challenge', destinoMascarado: '***88' },
  });
  assert.deepEqual(a.calls.service, [[{ contratoId, ...input }, a.sender]]);
  assert.equal(a.calls.provider, 0);
  assert.deepEqual(a.logs, []);
});
