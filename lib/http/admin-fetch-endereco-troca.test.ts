import assert from 'node:assert/strict';
import test from 'node:test';
import { carregarModulo } from '../acessos/teste-carregador.ts';

/**
 * Junção da troca de host (F2a, lib/enderecos/cliente.ts) com a espera da troca de empresa e o sinal de cancelamento
 * (experiência MCP). Falha decidida no próprio adminFetch (troca desta página pendente, prazo da espera, releitura que
 * cruzou outra troca ou cancelamento pelo sinal) não diz nada do servidor: não consulta o endereço nem conta no prazo
 * da troca de host. Falha HTTP de verdade continua consultando.
 */
type Sessao = { sessaoId: string | null; empresa: string | null } | 'http403';
const S1: Sessao = { sessaoId: 's1', empresa: 'A' };
const ARMAR = { modoEfetivo: 'ATIVA', painelNesteHost: true, toleranciaAtiva: true };
type Ctx = { iniciarTrocaDeEmpresa: () => void; encerrarTrocaDeEmpresa: () => void; lerAvisoDeContexto: () => string | null };

function ambiente(roteiro: { sessoes: Sessao[]; aoLer?: (n: number, ctx: Ctx) => void | Promise<void>; alvo?: number }) {
    const navegacoes: string[] = [];
    const armazenado = new Map<string, string>();
    const chamadas: string[] = [];
    let leitura = 0;
    const g = globalThis as unknown as Record<string, unknown>;
    g.window = { addEventListener() {}, removeEventListener() {}, location: { pathname: '/admin/configuracoes', search: '', replace: (u: string) => navegacoes.push(`replace:${u}`), assign: (u: string) => navegacoes.push(`assign:${u}`) } };
    g.sessionStorage = { getItem: (k: string) => armazenado.get(k) ?? null, setItem: (k: string, v: string) => armazenado.set(k, v), removeItem: (k: string) => armazenado.delete(k) };
    const cache = new Map();
    const mod = carregarModulo('lib/http/admin-fetch.ts', {}, cache) as unknown as { adminFetch: (u: string, i?: RequestInit) => Promise<Response>; ESPERA_DA_TROCA: { prazoMs: number }; AVISO_ESCRITA_CONFIRMADA_SEM_CONTEXTO: string };
    const ctx = carregarModulo('lib/http/contexto-empresa-cliente.ts', {}, cache) as unknown as Ctx & { registrarContextoEmpresa: (s: string, e: string | null) => boolean };
    const cli = carregarModulo('lib/enderecos/cliente.ts', {}, cache) as unknown as { iniciarAcompanhamento: () => () => void; enderecoFinal: () => boolean };
    g.fetch = async (input: string, init: RequestInit = {}) => {
        chamadas.push(String(input));
        if (input === '/api/endereco-atual') return new Response(JSON.stringify(ARMAR));
        if (input === '/api/admin/autenticacao') {
            const n = leitura;
            leitura += 1;
            await roteiro.aoLer?.(n, ctx);
            if (init.signal?.aborted) throw init.signal.reason;
            const s = roteiro.sessoes[Math.min(n, roteiro.sessoes.length - 1)];
            if (s === 'http403') return new Response('{"ok":false}', { status: 403 });
            return new Response(JSON.stringify({ ok: true, data: { usuarioId: s.sessaoId ? 'u' : null, sessaoId: s.sessaoId, csrf: 'c', contexto: { empresaAtual: s.empresa ? { id: s.empresa } : null } } }));
        }
        return new Response('{"ok":true}', { status: roteiro.alvo ?? 200, headers: { 'content-type': 'application/json' } });
    };
    ctx.registrarContextoEmpresa('s1', 'A');
    // Consulta com menos de 30 s é reaproveitada (INTERVALO_FORCADO_MS): o relógio anda 31 s depois de armar, para
    // "consultou ou não" ser observável.
    const armar = async () => {
        const parar = cli.iniciarAcompanhamento();
        await new Promise((r) => setImmediate(r));
        parar();
        const base = agoraReal();
        Date.now = () => base + 31_000;
    };
    return {
        mod, ctx, cli, armar, navegacoes,
        consultas: () => chamadas.filter((c) => c === '/api/endereco-atual').length,
        envios: () => chamadas.filter((c) => c === '/api/x').length,
    };
}

const agoraReal = Date.now;
test.afterEach(() => { Date.now = agoraReal; });

async function erroDe(p: Promise<unknown>) {
    try { await p; }
    catch (e) { return e as Error & { tipo?: string; enviado?: boolean; name?: string }; }
    throw Error('deveria ter falhado');
}

test('controle: aba armada e 403 de verdade na confirmação posterior consultam o endereço', async () => {
    const a = ambiente({ sessoes: [S1, 'http403'] });
    await a.armar();
    const antes = a.consultas();
    await erroDe(a.mod.adminFetch('/api/x'));
    assert.ok(a.consultas() > antes, 'falha HTTP alimenta a troca de host');
});

test('aba armada, troca de empresa desta página pendente vence o prazo depois do POST: falha local, sem consultar o endereço', async () => {
    const a = ambiente({ sessoes: [S1, S1], aoLer: (n, ctx) => { if (n === 1) ctx.iniciarTrocaDeEmpresa(); } });
    a.mod.ESPERA_DA_TROCA.prazoMs = 50;
    await a.armar();
    const antes = a.consultas();
    const e = await erroDe(a.mod.adminFetch('/api/x', { method: 'POST' }));
    assert.deepEqual([e.tipo, e.enviado], ['SESSAO_NAO_CONFIRMADA', true]);
    assert.equal(a.consultas(), antes, 'prazo da troca de empresa não é indício de troca de host');
    assert.equal(a.cli.enderecoFinal(), false);
    assert.equal(a.ctx.lerAvisoDeContexto(), a.mod.AVISO_ESCRITA_CONFIRMADA_SEM_CONTEXTO, 'o resultado conhecido da escrita fica guardado');
    assert.deepEqual(a.navegacoes, [], 'com a troca pendente, a navegação é dela');
    assert.equal(a.envios(), 1);
    a.ctx.encerrarTrocaDeEmpresa();
});

test('aba armada, troca pendente na confirmação prévia: nada sai e o endereço não é consultado', async () => {
    const a = ambiente({ sessoes: [S1], aoLer: (n, ctx) => { if (n === 0) ctx.iniciarTrocaDeEmpresa(); } });
    a.mod.ESPERA_DA_TROCA.prazoMs = 50;
    await a.armar();
    const antes = a.consultas();
    const e = await erroDe(a.mod.adminFetch('/api/x', { method: 'POST' }));
    assert.deepEqual([e.tipo, e.enviado], ['SESSAO_NAO_CONFIRMADA', false]);
    assert.equal(a.consultas(), antes);
    assert.equal(a.envios(), 0);
    a.ctx.encerrarTrocaDeEmpresa();
});

test('aba armada, leitura cancelada pelo sinal na confirmação prévia: termina com o motivo, sem consultar', async () => {
    const controle = new AbortController();
    const a = ambiente({ sessoes: [S1], aoLer: (n) => { if (n === 0) controle.abort(); } });
    await a.armar();
    const antes = a.consultas();
    const e = await erroDe(a.mod.adminFetch('/api/x', { signal: controle.signal }));
    assert.equal(e, controle.signal.reason);
    assert.equal(a.consultas(), antes, 'cancelamento não é falha do servidor');
    assert.equal(a.envios(), 0);
    assert.deepEqual(a.navegacoes, []);
});

test('aba armada, leitura cancelada pelo sinal na confirmação posterior: termina com o motivo, sem consultar nem descartar', async () => {
    const controle = new AbortController();
    const a = ambiente({ sessoes: [S1, S1], aoLer: (n) => { if (n === 1) controle.abort(); } });
    await a.armar();
    const antes = a.consultas();
    const e = await erroDe(a.mod.adminFetch('/api/x', { signal: controle.signal }));
    assert.equal(e, controle.signal.reason);
    assert.equal(a.consultas(), antes);
    assert.deepEqual(a.navegacoes, []);
    assert.equal(a.ctx.lerAvisoDeContexto(), null);
});
