// Testes da guarda de rede da avaliação: SÓ mocks (o fetch original é substituído por uma função que registra a
// chamada). Nenhuma chamada real de rede acontece; por garantia, o fetch global deste processo falha.
//   node --test scripts/walle-avaliacao/teste-guarda-rede.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { criarFetchProtegido, destinoPermitido, ERRO_DESTINO, ERRO_REDIRECIONAMENTO } from './guarda-rede.mjs';

globalThis.fetch = async () => { throw new Error('rede real proibida no teste'); };
const PERMITIDA = 'https://api.openai.com/v1/responses';

function mock(resposta = { status: 200, redirected: false }) {
  const chamadas = [];
  const fn = async (alvo, opcoes) => { chamadas.push({ alvo, opcoes }); return typeof resposta === 'function' ? resposta(alvo, opcoes) : resposta; };
  return { fn, chamadas };
}
const avisos = () => { const lista = []; return { lista, avisar: (e) => lista.push(e) }; };

test('modo regras recusa tudo, inclusive a OpenAI, sem chamar o fetch original', async () => {
  const m = mock(), a = avisos();
  const f = criarFetchProtegido('regras', m.fn, a.avisar);
  for (const u of [PERMITIDA, 'https://api.gupshup.io/wa/api/v1/msg', 'http://127.0.0.1:3060/']) await assert.rejects(f(u), { message: ERRO_DESTINO });
  assert.equal(m.chamadas.length, 0);
  assert.equal(a.lista.length, 3);
});

test('modo ia recusa destinos externos e variações enganosas, sem chamar o fetch original', async () => {
  const externos = [
    'https://api.gupshup.io/wa/api/v1/msg',                 // transporte WhatsApp real
    'https://partner.gupshup.io/partner/app/x/subscription',
    'http://api.openai.com/v1/responses',                   // sem TLS
    'https://api.openai.com.evil.test/v1/responses',        // sufixo
    'https://evil.test/https://api.openai.com/v1/',         // URL dentro do caminho
    'https://api.openai.com@evil.test/v1/responses',        // usuário enganoso
    'https://user:senha@api.openai.com/v1/responses',       // credencial na URL
    'https://api.openai.com:8443/v1/responses',             // outra porta
    'https://api.openai.com./v1/responses',                 // host com ponto final
    'https://api.openai.com/v2/responses',                  // fora de /v1/
    'https://api.deepseek.com/v1/chat/completions',          // outro provedor de IA
    'file:///C:/Windows/win.ini', 'data:text/plain,oi', 'não é url', '',
  ];
  const m = mock(), a = avisos();
  const f = criarFetchProtegido('ia', m.fn, a.avisar);
  for (const u of externos) await assert.rejects(f(u), { message: ERRO_DESTINO }, u);
  await assert.rejects(f(new URL('https://api.gupshup.io/wa/api/v1/msg')), { message: ERRO_DESTINO });
  await assert.rejects(f(new Request('https://api.gupshup.io/wa/api/v1/msg', { method: 'POST' })), { message: ERRO_DESTINO });
  await assert.rejects(f(undefined), { message: ERRO_DESTINO });
  assert.equal(m.chamadas.length, 0, 'nenhum destino externo pode chegar ao fetch original');
  assert.ok(a.lista.every((e) => e.evento === 'destino recusado' && !String(e.origem).includes('senha')));
});

test('modo ia libera só a OpenAI e sempre com redirect: error, mesmo se quem chama pedir follow', async () => {
  const m = mock(), f = criarFetchProtegido('ia', m.fn);
  await f(PERMITIDA, { method: 'POST', redirect: 'follow', headers: { authorization: 'Bearer x' } });
  await f(new URL(PERMITIDA));
  await f(new Request(PERMITIDA, { method: 'POST', redirect: 'follow' }));
  await f(PERMITIDA);
  assert.equal(m.chamadas.length, 4);
  for (const c of m.chamadas) assert.equal(c.opcoes.redirect, 'error');
  assert.equal(m.chamadas[0].opcoes.method, 'POST', 'as demais opções são preservadas');
});

test('resposta de redirecionamento é recusada (3xx ou marcada como redirecionada)', async () => {
  const a = avisos();
  for (const status of [301, 302, 303, 307, 308]) {
    const f = criarFetchProtegido('ia', mock({ status, redirected: false, headers: new Headers({ location: 'https://evil.test/' }) }).fn, a.avisar);
    await assert.rejects(f(PERMITIDA), { message: ERRO_REDIRECIONAMENTO }, String(status));
  }
  const seguida = criarFetchProtegido('ia', mock({ status: 200, redirected: true }).fn, a.avisar);
  await assert.rejects(seguida(PERMITIDA), { message: ERRO_REDIRECIONAMENTO });
  assert.equal(a.lista.filter((e) => e.evento === 'redirecionamento recusado').length, 6);
});

test('redirect: error é o que impede seguir: o mock reproduz a regra do fetch (com follow, seguiria para fora)', async () => {
  // Mock fiel à semântica do fetch: com redirect 'follow' devolveria o destino final externo; com 'error', rejeita.
  const destinos = [];
  const fetchComRegra = async (alvo, opcoes) => {
    if (opcoes?.redirect === 'error') throw new TypeError('fetch failed: redirect mode is set to error');
    destinos.push('https://evil.test/'); return { status: 200, redirected: true, url: 'https://evil.test/' };
  };
  const f = criarFetchProtegido('ia', fetchComRegra);
  await assert.rejects(f(PERMITIDA, { redirect: 'follow' }), TypeError);
  assert.deepEqual(destinos, [], 'nenhum destino externo foi alcançado');
});

test('respostas normais passam sem alteração', async () => {
  const resposta = { status: 200, redirected: false, ok: true, corpo: 'x' };
  const f = criarFetchProtegido('ia', mock(resposta).fn);
  assert.equal(await f(PERMITIDA), resposta);
  const erro = { status: 401, redirected: false, ok: false };
  assert.equal(await criarFetchProtegido('ia', mock(erro).fn)(PERMITIDA), erro, '4xx/5xx seguem para o roteador tratar');
});

test('configuração inválida é recusada', () => {
  assert.throws(() => criarFetchProtegido('outro', async () => ({})));
  assert.throws(() => criarFetchProtegido('ia', null));
  assert.equal(destinoPermitido('regras', PERMITIDA), false);
  assert.equal(destinoPermitido('ia', PERMITIDA), true);
});
