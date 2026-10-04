import assert from 'node:assert/strict';
import test from 'node:test';
import { carregarModulo } from '../acessos/teste-carregador.ts';

/**
 * Cliente do contexto de acesso (sem navegador): renovação de sessão só quando comprovada pelo servidor, nenhuma
 * escrita repetida e aviso com o resultado real quando a empresa/sessão muda durante uma operação.
 */
type Resp = { status: number; corpo: unknown };
type Leitura = { sessaoId: string | null; empresa: string | null } | 'rede' | 'http500' | 'corpo-invalido';
function ambiente(roteiro: { sessoes: Leitura[]; alvo?: Resp | 'rede'; reautenticar?: Resp }) {
    const navegacoes: string[] = [];
    const armazenado = new Map<string, string>();
    const chamadas: Array<{ url: string; metodo: string; sessao: string | null }> = [];
    let leitura = 0;
    const g = globalThis as unknown as Record<string, unknown>;
    g.window = { location: { pathname: '/admin/clientes', replace: (u: string) => navegacoes.push(`replace:${u}`), assign: (u: string) => navegacoes.push(`assign:${u}`) } };
    g.sessionStorage = { getItem: (k: string) => armazenado.get(k) ?? null, setItem: (k: string, v: string) => armazenado.set(k, v), removeItem: (k: string) => armazenado.delete(k) };
    g.fetch = async (input: string, init: RequestInit = {}) => {
        const metodo = (init.method ?? 'GET').toUpperCase();
        const sessao = new Headers(init.headers).get('x-kidmais-sessao');
        chamadas.push({ url: String(input), metodo, sessao });
        if (String(input) === '/api/admin/autenticacao' && metodo === 'GET') {
            const s = roteiro.sessoes[Math.min(leitura, roteiro.sessoes.length - 1)];
            leitura += 1;
            if (s === 'rede') throw new TypeError('fetch failed');
            if (s === 'http500') return new Response('{}', { status: 500 });
            if (s === 'corpo-invalido') return new Response('<html>', { status: 200 });
            return new Response(JSON.stringify({ ok: true, data: { usuarioId: s.sessaoId ? 'u' : null, sessaoId: s.sessaoId, csrf: 'c', contexto: { empresaAtual: s.empresa ? { id: s.empresa } : null } } }));
        }
        if (String(input) === '/api/admin/autenticacao') {
            const r = roteiro.reautenticar!;
            return new Response(JSON.stringify(r.corpo), { status: r.status });
        }
        if (roteiro.alvo === 'rede')
            throw new TypeError('fetch failed');
        return new Response(JSON.stringify(roteiro.alvo!.corpo), { status: roteiro.alvo!.status });
    };
    const mod = carregarModulo('lib/http/admin-fetch.ts', {}, new Map()) as Record<string, (...a: unknown[]) => Promise<unknown>>;
    const ctx = carregarModulo('lib/http/contexto-empresa-cliente.ts', {}, new Map()) as Record<string, (...a: unknown[]) => unknown>;
    return { mod, ctx, navegacoes, chamadas, aviso: () => armazenado.get('kidmais-aviso-contexto') ?? null, alvos: () => chamadas.filter((c) => c.url === '/api/x').length };
}
// O carregador cria instâncias separadas; admin-fetch usa a SUA instância do contexto. Os testes observam pelo comportamento.

test('escrita normal: um único envio, com a sessão da página no cabeçalho; nenhum descarte', async () => {
    const a = ambiente({ sessoes: [{ sessaoId: 's1', empresa: 'A' }], alvo: { status: 200, corpo: { ok: true } } });
    const r = await a.mod.adminFetch('/api/x', { method: 'POST' }) as Response;
    assert.equal(r.status, 200);
    assert.equal(a.alvos(), 1);
    assert.equal(a.chamadas.find((c) => c.url === '/api/x')!.sessao, 's1');
    assert.deepEqual(a.navegacoes, []);
});

test('empresa mudou ANTES do envio: nada é enviado, página descartada com aviso', async () => {
    const a = ambiente({ sessoes: [{ sessaoId: 's1', empresa: 'A' }, { sessaoId: 's1', empresa: 'A' }, { sessaoId: 's2', empresa: 'B' }], alvo: { status: 200, corpo: { ok: true } } });
    await a.mod.adminFetch('/api/x');
    await assert.rejects(a.mod.adminFetch('/api/x', { method: 'POST' }));
    assert.equal(a.chamadas.filter((c) => c.url === '/api/x' && c.metodo === 'POST').length, 0);
    assert.match(a.aviso()!, /antes do envio\. Nada foi enviado/);
    assert.equal(a.navegacoes.at(-1), 'replace:/admin/dashboard');
});

test('servidor recusou pelo contexto antigo (409): nada alterado, descarte e um único envio', async () => {
    const a = ambiente({ sessoes: [{ sessaoId: 's1', empresa: 'A' }], alvo: { status: 409, corpo: { ok: false, codigo: 'AUTENTICACAO_ADMINISTRATIVA' } } });
    await assert.rejects(a.mod.adminFetch('/api/x', { method: 'POST' }), /Nada foi alterado/);
    assert.equal(a.alvos(), 1);
    assert.match(a.aviso()!, /antes de a operação ser processada\. Nada foi alterado/);
});

test('escrita concluída e contexto trocado depois: aviso "concluída", dados descartados, sem repetir', async () => {
    const a = ambiente({ sessoes: [{ sessaoId: 's1', empresa: 'A' }, { sessaoId: 's2', empresa: 'B' }], alvo: { status: 200, corpo: { ok: true } } });
    await assert.rejects(a.mod.adminFetch('/api/x', { method: 'POST' }), /concluída antes da mudança/);
    assert.equal(a.alvos(), 1);
    assert.match(a.aviso()!, /concluída antes da mudança/);
});

test('escrita com erro 5xx e contexto trocado: resultado incerto; recusa 4xx: não concluída', async () => {
    const incerto = ambiente({ sessoes: [{ sessaoId: 's1', empresa: 'A' }, { sessaoId: 's2', empresa: 'B' }], alvo: { status: 502, corpo: {} } });
    await assert.rejects(incerto.mod.adminFetch('/api/x', { method: 'POST' }));
    assert.match(incerto.aviso()!, /Resultado incerto/);
    const recusa = ambiente({ sessoes: [{ sessaoId: 's1', empresa: 'A' }, { sessaoId: 's2', empresa: 'B' }], alvo: { status: 401, corpo: {} } });
    await assert.rejects(recusa.mod.adminFetch('/api/x', { method: 'POST' }));
    assert.match(recusa.aviso()!, /não foi concluída: o servidor recusou/);
});

test('suspensão durante a escrita (sessão encerrada depois da resposta): login com aviso do resultado', async () => {
    const a = ambiente({ sessoes: [{ sessaoId: 's1', empresa: 'A' }, { sessaoId: null, empresa: null }], alvo: { status: 200, corpo: { ok: true } } });
    await assert.rejects(a.mod.adminFetch('/api/x', { method: 'POST' }));
    assert.equal(a.navegacoes.at(-1), 'replace:/admin/login');
    assert.match(a.aviso()!, /concluída antes da mudança/);
});

test('conexão caiu durante a escrita: resultado incerto, nenhuma repetição e nenhum descarte automático', async () => {
    const a = ambiente({ sessoes: [{ sessaoId: 's1', empresa: 'A' }], alvo: 'rede' });
    await assert.rejects(a.mod.adminFetch('/api/x', { method: 'POST' }), /Resultado incerto/);
    assert.equal(a.alvos(), 1);
    assert.deepEqual(a.navegacoes, []);
});

test('reautenticação: renovação comprovada aceita (mesma empresa); próxima escrita segue na tela com a sessão nova', async () => {
    const a = ambiente({
        sessoes: [{ sessaoId: 's1', empresa: 'A' }, { sessaoId: 's1', empresa: 'A' }, { sessaoId: 's2', empresa: 'A' }],
        reautenticar: { status: 200, corpo: { ok: true, data: { renovacao: { anterior: 's1', atual: 's2' } } } },
        alvo: { status: 200, corpo: { ok: true } },
    });
    assert.deepEqual(await a.mod.reautenticarSessao('certa'), { ok: true });
    await a.mod.adminFetch('/api/x', { method: 'POST' });
    assert.equal(a.chamadas.find((c) => c.url === '/api/x')!.sessao, 's2');
    assert.deepEqual(a.navegacoes, [], 'permanece na tela');
    assert.equal(a.alvos(), 1);
});

test('reautenticação: senha incorreta mantém sessão e contexto (sem descarte); escrita seguinte usa a mesma sessão', async () => {
    const a = ambiente({ sessoes: [{ sessaoId: 's1', empresa: 'A' }], reautenticar: { status: 401, corpo: { ok: false, erro: 'Credenciais inválidas.' } }, alvo: { status: 200, corpo: { ok: true } } });
    const r = await a.mod.reautenticarSessao('errada') as { ok: boolean; senhaIncorreta: boolean; erro: string };
    assert.deepEqual([r.ok, r.senhaIncorreta, r.erro], [false, true, 'Senha incorreta.']);
    await a.mod.adminFetch('/api/x', { method: 'POST' });
    assert.equal(a.chamadas.find((c) => c.url === '/api/x')!.sessao, 's1');
    assert.deepEqual(a.navegacoes, []);
});

test('renovação NÃO comprovada é recusada: anterior diferente, sessão do servidor diferente ou empresa trocada', async () => {
    for (const [nome, renovacao, depois] of [
        ['anterior divergente', { anterior: 'outra', atual: 's2' }, { sessaoId: 's2', empresa: 'A' }],
        ['sessão do servidor divergente', { anterior: 's1', atual: 's2' }, { sessaoId: 's3', empresa: 'A' }],
        ['empresa trocada', { anterior: 's1', atual: 's2' }, { sessaoId: 's2', empresa: 'B' }],
        ['sem renovação na resposta', null, { sessaoId: 's2', empresa: 'A' }],
    ] as const) {
        const a = ambiente({ sessoes: [{ sessaoId: 's1', empresa: 'A' }, { sessaoId: 's1', empresa: 'A' }, depois], reautenticar: { status: 200, corpo: { ok: true, data: { renovacao } } } });
        const r = await a.mod.reautenticarSessao('certa') as { ok: boolean };
        assert.equal(r.ok, false, nome);
        assert.equal(a.navegacoes.at(-1), 'replace:/admin/dashboard', nome);
    }
});

test('troca de sessão sem reautenticação (mesma empresa) continua descartando a página', async () => {
    const a = ambiente({ sessoes: [{ sessaoId: 's1', empresa: 'A' }, { sessaoId: 's1', empresa: 'A' }, { sessaoId: 's2', empresa: 'A' }], alvo: { status: 200, corpo: { ok: true } } });
    await a.mod.adminFetch('/api/x');
    await assert.rejects(a.mod.adminFetch('/api/x', { method: 'POST' }));
    assert.equal(a.navegacoes.at(-1), 'replace:/admin/dashboard');
});

// ---------------------------------------------------------------- falha na confirmação depois da resposta
// Cenário: a empresa foi trocada em outra aba durante a operação e a consulta de confirmação falha. A página não sabe
// qual é o contexto atual: nada pode ser entregue ao componente.
const A = { sessaoId: 's1', empresa: 'A' } as const;

test('GET + troca de empresa + falha na confirmação: dados NÃO entregues, tela descartada com aviso', async () => {
    for (const falha of ['rede', 'http500', 'corpo-invalido'] as const) {
        const a = ambiente({ sessoes: [A, falha], alvo: { status: 200, corpo: { ok: true, data: { segredo: 'dado-da-empresa-A' } } } });
        let entregue: unknown = null;
        await assert.rejects(async () => { entregue = await a.mod.adminFetch('/api/x'); }, /Não foi possível confirmar a empresa ativa depois da leitura/);
        assert.equal(entregue, null, `${falha}: a resposta não chega ao componente`);
        assert.equal(a.navegacoes.at(-1), 'replace:/admin/dashboard', falha);
        assert.match(a.aviso()!, /dados recebidos foram descartados/, falha);
        assert.equal(a.alvos(), 1, falha);
    }
});

test('escrita CONFIRMADA + troca + falha na confirmação: continua "concluída" (não vira incerta), sem repetir', async () => {
    const a = ambiente({ sessoes: [A, 'rede'], alvo: { status: 200, corpo: { ok: true } } });
    await assert.rejects(a.mod.adminFetch('/api/x', { method: 'POST' }), /foi concluída, mas não foi possível confirmar/);
    assert.match(a.aviso()!, /foi concluída, mas não foi possível confirmar a empresa ativa/);
    assert.doesNotMatch(a.aviso()!, /incerto/i);
    assert.equal(a.alvos(), 1);
    assert.equal(a.navegacoes.at(-1), 'replace:/admin/dashboard');
});

test('escrita com 5xx + falha na confirmação: incerta; com recusa 4xx: não concluída; ambas sem repetir', async () => {
    const incerta = ambiente({ sessoes: [A, 'http500'], alvo: { status: 503, corpo: {} } });
    await assert.rejects(incerta.mod.adminFetch('/api/x', { method: 'POST' }));
    assert.match(incerta.aviso()!, /Resultado incerto/);
    assert.equal(incerta.alvos(), 1);
    const recusada = ambiente({ sessoes: [A, 'rede'], alvo: { status: 422, corpo: { ok: false } } });
    await assert.rejects(recusada.mod.adminFetch('/api/x', { method: 'POST' }));
    assert.match(recusada.aviso()!, /não foi concluída: o servidor recusou/);
    assert.equal(recusada.alvos(), 1);
});

test('escrita com resposta PERDIDA continua incerta mesmo que a confirmação também falhe; nunca reenvia', async () => {
    const a = ambiente({ sessoes: [A, 'rede'], alvo: 'rede' });
    await assert.rejects(a.mod.adminFetch('/api/x', { method: 'POST' }), /Resultado incerto/);
    assert.equal(a.alvos(), 1);
});

test('falha na confirmação ANTES do envio: nada é enviado nem entregue', async () => {
    const leitura = ambiente({ sessoes: ['rede'], alvo: { status: 200, corpo: { ok: true } } });
    await assert.rejects(leitura.mod.adminFetch('/api/x'), /Não foi possível confirmar a sessão/);
    const escrita = ambiente({ sessoes: ['http500'], alvo: { status: 200, corpo: { ok: true } } });
    await assert.rejects(escrita.mod.adminFetch('/api/x', { method: 'POST' }), /Nada foi enviado/);
    assert.equal(leitura.alvos() + escrita.alvos(), 0);
});
