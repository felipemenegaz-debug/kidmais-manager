import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { carregarModulo } from '../acessos/teste-carregador.ts';

/** adminFetch durante a troca de host (plano D4, H23): tela mantida, leitura não entregue, escrita não repetida (G16). */
type Sessao = { sessaoId: string | null; empresa: string | null } | 'rede' | 'http500' | 'http401' | 'http403' | 'corpo-invalido';
type Passo = Record<string, unknown> | 'rede';
const consulta = (modoEfetivo: string, painelNesteHost: boolean | null, toleranciaAtiva = true) => ({ modoEfetivo, painelNesteHost, toleranciaAtiva });
const S1: Sessao = { sessaoId: 's1', empresa: 'A' };

function ambiente(roteiro: { sessoes: Sessao[]; alvo?: { status: number; corpo: unknown }; diagnostico: Passo[]; antesDoAlvo?: () => Promise<void>; aoLer?: (n: number) => Promise<void>; aoDiagnostico?: () => void; aoLerCorpo?: () => Promise<void>; aoLerJson?: () => Promise<void> }) {
    const navegacoes: string[] = [];
    const armazenado = new Map<string, string>();
    const chamadas: Array<{ url: string; metodo: string }> = [];
    let leitura = 0;
    let d = 0;
    const g = globalThis as unknown as Record<string, unknown>;
    g.window = { addEventListener() {}, removeEventListener() {}, location: { pathname: '/admin/clientes', search: '', replace: (u: string) => navegacoes.push(`replace:${u}`), assign: (u: string) => navegacoes.push(`assign:${u}`) } };
    g.sessionStorage = { getItem: (k: string) => armazenado.get(k) ?? null, setItem: (k: string, v: string) => armazenado.set(k, v), removeItem: (k: string) => armazenado.delete(k) };
    g.fetch = async (input: string, init: RequestInit = {}) => {
        const metodo = (init.method ?? 'GET').toUpperCase();
        chamadas.push({ url: String(input), metodo });
        if (input === '/api/endereco-atual') {
            roteiro.aoDiagnostico?.();
            const p = roteiro.diagnostico[Math.min(d, roteiro.diagnostico.length - 1)];
            d += 1;
            if (p === 'rede') throw new TypeError('fetch failed');
            return new Response(JSON.stringify(p));
        }
        if (input === '/api/admin/autenticacao' && metodo === 'GET') {
            const n = leitura;
            await roteiro.aoLer?.(n);
            const s = roteiro.sessoes[Math.min(n, roteiro.sessoes.length - 1)];
            leitura += 1;
            if (s === 'rede') throw new TypeError('fetch failed');
            if (s === 'http500') return new Response('{}', { status: 500 });
            if (s === 'http401') return new Response('{"ok":false}', { status: 401 });
            if (s === 'http403') return new Response('{"ok":false}', { status: 403 });
            if (s === 'corpo-invalido') return new Response('<html>', { status: 200 });
            return new Response(JSON.stringify({ ok: true, data: { usuarioId: s.sessaoId ? 'u' : null, sessaoId: s.sessaoId, csrf: 'c', contexto: { empresaAtual: s.empresa ? { id: s.empresa } : null } } }));
        }
        await roteiro.antesDoAlvo?.();
        const resposta = new Response(JSON.stringify(roteiro.alvo?.corpo ?? { ok: true }), { status: roteiro.alvo?.status ?? 200, headers: { 'content-type': 'application/json' } });
        const corpoDoAlvo = roteiro.alvo?.corpo;
        if (roteiro.aoLerJson) { const ler = resposta.json.bind(resposta); resposta.json = async () => { await roteiro.aoLerJson!(); return ler(); }; }
        if (roteiro.aoLerCorpo) resposta.clone = () => ({ json: async () => { await roteiro.aoLerCorpo!(); return corpoDoAlvo; } }) as unknown as Response;
        return resposta;
    };
    const cache = new Map();
    const mod = carregarModulo('lib/http/admin-fetch.ts', {}, cache) as unknown as { adminFetch: (u: string, i?: RequestInit) => Promise<Response>; reautenticarSessao: (s: string) => Promise<{ ok: boolean; erro?: string; senhaIncorreta?: boolean }>; trocarEmpresaAtiva: (e: string) => Promise<Response>; AVISO_RENOVACAO_EM_VERIFICACAO: string; lerCorpoOuNulo: (r: Response) => Promise<unknown>; mensagemDoEndereco: (e: unknown) => string | null };
    const ctx = carregarModulo('lib/http/contexto-empresa-cliente.ts', {}, cache) as unknown as { iniciarTrocaDeEmpresa: () => void; reiniciarContextoEmpresa: (a?: string, d?: string, o?: string) => void; registrarContextoEmpresa: (s: string, e: string | null) => boolean };
    const cli = carregarModulo('lib/enderecos/cliente.ts', {}, cache) as unknown as { iniciarAcompanhamento: () => () => void; decidirFalhaSessao: (e: unknown) => Promise<string>; estadoAviso: () => string; enderecoFinal: () => boolean; resultadosDaTelaMantida: () => string[]; sessaoValida: () => void };
    const armar = async () => { const parar = cli.iniciarAcompanhamento(); await new Promise((r) => setImmediate(r)); parar(); };
    return { mod, cli, ctx, armar, posts: () => chamadas.filter((c) => c.metodo === 'POST').length, navegacoes, chamadas, aviso: () => armazenado.get('kidmais-aviso-contexto') ?? null, envios: () => chamadas.filter((c) => c.url === '/api/x').length, consultas: () => chamadas.filter((c) => c.url === '/api/endereco-atual').length };
}

async function erroDe(p: Promise<unknown>) {
    try { await p; }
    catch (e) { return e as Error & { tipo?: string; enviado?: boolean }; }
    throw Error('deveria ter falhado');
}
const NAO_ARMAR = consulta('DESLIGADO', null);
const TROCA_PROVADA = [consulta('ATIVA', false)];
type Amb = ReturnType<typeof ambiente>;
const chegarAoFinal = (a: Amb) => a.cli.decidirFalhaSessao({ tipo: '403', telaCarregada: true, aindaValida: () => true });
const ENCERRADA: Sessao = { sessaoId: null, empresa: null };
const OUTRA: Sessao = { sessaoId: 's2', empresa: 'B' };
const RENOVACAO = { status: 200, corpo: { ok: true, data: { renovacao: { anterior: 's1', atual: 's2' } } } };
const S2_MESMA: Sessao = { sessaoId: 's2', empresa: 'A' };
const RECUSA_409 = { status: 409, corpo: { codigo: 'AUTENTICACAO_ADMINISTRATIVA' } };
const agoraReal = Date.now;
function relogio() {
    let t = agoraReal();
    Date.now = () => t;
    return { avancar: (ms: number) => { t += ms; }, parar: () => { Date.now = agoraReal; } };
}

test('aba armada, sessão perdida depois da leitura: dados não entregues, sem descarte e sem aviso de escrita', async () => {
    const a = ambiente({ sessoes: [S1, 'http403'], diagnostico: [consulta('ATIVA', false, false)] });
    const e = await erroDe(a.mod.adminFetch('/api/x'));
    assert.equal(e.tipo, 'ENDERECO_EM_VERIFICACAO');
    assert.equal(e.enviado, true);
    assert.deepEqual(a.navegacoes, []);
    assert.equal(a.aviso(), null);
    assert.equal(a.cli.enderecoFinal(), true);
});

test('escrita: resultado real, sem repetir e sem dizer que a tela foi recarregada', async () => {
    const casos: Array<[number, RegExp]> = [[200, /concluída.*Não repita/], [201, /concluída/], [500, /Resultado incerto/], [503, /Resultado incerto/], [422, /não foi concluída: o servidor recusou/]];
    for (const [status, texto] of casos) {
        const a = ambiente({ sessoes: [S1, 'http403'], alvo: { status, corpo: {} }, diagnostico: [consulta('ATIVA', false)] });
        const e = await erroDe(a.mod.adminFetch('/api/x', { method: 'POST' }));
        assert.equal(e.tipo, 'ENDERECO_EM_VERIFICACAO', String(status));
        assert.match(e.message, texto);
        assert.doesNotMatch(e.message, /recarregada|descartados/);
        assert.match(a.aviso()!, texto, 'o resultado fica registrado para a próxima tela');
        assert.equal(a.envios(), 1);
        assert.deepEqual(a.navegacoes, []);
    }
});

test('inconclusivo em aba armada: mesma proteção, tentando de novo', async () => {
    const a = ambiente({ sessoes: [S1, 'http500'], diagnostico: [consulta('ATIVA', true), 'rede'] });
    await a.armar();
    const agora = Date.now;
    const inicio = agora();
    Date.now = () => inicio + 31000;
    try {
        const e = await erroDe(a.mod.adminFetch('/api/x', { method: 'POST' }));
        assert.equal(e.tipo, 'ENDERECO_EM_VERIFICACAO');
        assert.equal(a.cli.estadoAviso(), 'SEM_RESPOSTA');
        assert.deepEqual(a.navegacoes, []);
        assert.match(a.aviso()!, /concluída/);
    }
    finally { Date.now = agora; }
});

test('aba armada, painel neste host em consulta nova: problema da sessão, descarte de hoje', async () => {
    const a = ambiente({ sessoes: [S1, 'http500'], diagnostico: [consulta('ATIVA', true), consulta('ATIVA', true)] });
    await a.armar();
    const agora = Date.now;
    const inicio = agora();
    Date.now = () => inicio + 31000;
    try {
        const e = await erroDe(a.mod.adminFetch('/api/x'));
        assert.equal(e.tipo, 'SESSAO_NAO_CONFIRMADA');
        assert.equal(a.navegacoes.at(-1), 'replace:/admin/dashboard');
    }
    finally { Date.now = agora; }
});

test('sem aba armada: falha genérica depois da resposta segue como hoje, sem consulta', async () => {
    for (const s of ['http500', 'rede', 'corpo-invalido'] as Sessao[]) {
        const a = ambiente({ sessoes: [S1, s], diagnostico: [consulta('ATIVA', false)] });
        const e = await erroDe(a.mod.adminFetch('/api/x'));
        assert.equal(e.tipo, 'SESSAO_NAO_CONFIRMADA');
        assert.equal(a.consultas(), 0);
        assert.equal(a.navegacoes.at(-1), 'replace:/admin/dashboard');
    }
});

test('401 na confirmação: como hoje, sem consulta, mesmo com a aba armada e a troca já no ar', async () => {
    const r = relogio();
    try {
        const a = ambiente({ sessoes: [S1, 'http401'], diagnostico: [consulta('ATIVA', true), consulta('ATIVA', false)] });
        await a.armar();
        r.avancar(31000);
        const antes = a.consultas();
        const e = await erroDe(a.mod.adminFetch('/api/x'));
        assert.equal(e.tipo, 'SESSAO_NAO_CONFIRMADA');
        assert.equal(a.consultas(), antes);
        assert.equal(a.cli.enderecoFinal(), false);
        assert.equal(a.navegacoes.at(-1), 'replace:/admin/dashboard');
    }
    finally { r.parar(); }
});

test('reautenticação: 401 na confirmação segue o descarte, sem consulta, mesmo com a aba armada e a troca já no ar', async () => {
    const r = relogio();
    try {
        const a = ambiente({ sessoes: [S1, S1, 'http401'], alvo: RENOVACAO, diagnostico: [consulta('ATIVA', true), consulta('ATIVA', false)] });
        await a.armar();
        r.avancar(31000);
        const antes = a.consultas();
        const res = await a.mod.reautenticarSessao('certa');
        assert.match(res.erro!, /de forma inesperada/);
        assert.equal(a.consultas(), antes);
        assert.equal(a.navegacoes.at(-1), 'replace:/admin/dashboard');
    }
    finally { r.parar(); }
});

test('reautenticação: estado final na primeira confirmação vem antes do contexto mudado', async () => {
    const a: Amb = ambiente({ sessoes: [S1, S1, OUTRA], diagnostico: TROCA_PROVADA, aoLer: async (n) => { if (n === 2) await chegarAoFinal(a); } });
    await a.mod.adminFetch('/api/x');
    const res = await a.mod.reautenticarSessao('certa');
    assert.match(res.erro!, /mudou de endereço. Nada foi enviado/);
    assert.deepEqual(a.navegacoes, []);
});

test('403 na confirmação sem armar e sem troca provada: recusa original', async () => {
    for (const p of [consulta('ATIVA', true), NAO_ARMAR, 'rede'] as Passo[]) {
        const a = ambiente({ sessoes: [S1, 'http403'], diagnostico: [p] });
        const e = await erroDe(a.mod.adminFetch('/api/x'));
        assert.equal(e.tipo, 'SESSAO_NAO_CONFIRMADA', JSON.stringify(p));
        assert.equal(a.navegacoes.at(-1), 'replace:/admin/dashboard');
    }
});

test('confirmação prévia recusada: nada enviado, erro de hoje, e a aba descobre a troca para o próximo pedido', async () => {
    const a = ambiente({ sessoes: ['http403'], diagnostico: [consulta('ATIVA', false)] });
    const e = await erroDe(a.mod.adminFetch('/api/x', { method: 'POST' }));
    assert.equal(e.tipo, 'SESSAO_NAO_CONFIRMADA');
    assert.equal(e.enviado, false);
    assert.equal(a.envios(), 0);
    await new Promise((r) => setImmediate(r));
    assert.equal(a.cli.enderecoFinal(), true);
    const proximo = await erroDe(a.mod.adminFetch('/api/x', { method: 'POST' }));
    assert.equal(proximo.tipo, 'ENDERECO_EM_VERIFICACAO');
    assert.equal(proximo.enviado, false);
    assert.equal(a.envios(), 0);
    assert.deepEqual(a.navegacoes, []);
});

test('confirmação prévia com falha genérica sem armar: nem consulta', async () => {
    const a = ambiente({ sessoes: ['http500'], diagnostico: [consulta('ATIVA', false)] });
    await erroDe(a.mod.adminFetch('/api/x'));
    await new Promise((r) => setImmediate(r));
    assert.equal(a.consultas(), 0);
});

test('estado final durante o pedido: leitura não entregue, escrita registrada, também nas rotas de autenticação', async () => {
    for (const url of ['/api/x', '/api/admin/perfil/senha']) {
        let a: ReturnType<typeof ambiente>;
        const chegarAoFinal = async () => { await a.cli.decidirFalhaSessao({ tipo: '403', telaCarregada: true, aindaValida: () => true }); };
        a = ambiente({ sessoes: [S1], diagnostico: [consulta('ATIVA', false)], antesDoAlvo: chegarAoFinal });
        const e = await erroDe(a.mod.adminFetch(url));
        assert.equal(e.tipo, 'ENDERECO_EM_VERIFICACAO', url);
        assert.equal(a.aviso(), null);
        a = ambiente({ sessoes: [S1], diagnostico: [consulta('ATIVA', false)], antesDoAlvo: chegarAoFinal });
        const w = await erroDe(a.mod.adminFetch(url, { method: 'POST' }));
        assert.equal(w.tipo, 'ENDERECO_EM_VERIFICACAO', url);
        assert.match(a.aviso()!, /concluída/);
        assert.deepEqual(a.navegacoes, []);
    }
});

test('precedência: contexto mudou continua descartando, mesmo com a aba armada', async () => {
    const a = ambiente({ sessoes: [S1, S1, S1, { sessaoId: 's2', empresa: 'B' }], diagnostico: [consulta('ATIVA', true)] });
    await a.armar();
    await a.mod.adminFetch('/api/x');
    const e = await erroDe(a.mod.adminFetch('/api/x'));
    assert.equal(e.tipo, 'CONTEXTO_MUDOU');
    assert.equal(a.navegacoes.at(-1), 'replace:/admin/dashboard');
});

test('sessão encerrada de verdade: login, como hoje', async () => {
    const a = ambiente({ sessoes: [S1, { sessaoId: null, empresa: null }], diagnostico: [consulta('ATIVA', true)] });
    await a.armar();
    const e = await erroDe(a.mod.adminFetch('/api/x'));
    assert.equal(e.tipo, 'SESSAO_ENCERRADA');
    assert.match(a.navegacoes.at(-1)!, /login/);
});

test('estado final durante a confirmação prévia: nada sai e nada navega, qualquer que seja a leitura', async () => {
    for (const s of [S1, 'http401', 'http403', 'http500', 'rede', 'corpo-invalido', ENCERRADA] as Sessao[]) {
        for (const method of ['POST', 'GET']) {
            const a: Amb = ambiente({ sessoes: [s], diagnostico: TROCA_PROVADA, aoLer: async () => { await chegarAoFinal(a); } });
            const e = await erroDe(a.mod.adminFetch('/api/x', { method }));
            assert.equal(e.tipo, 'ENDERECO_EM_VERIFICACAO', JSON.stringify(s));
            assert.equal(e.enviado, false);
            assert.equal(a.envios(), 0, JSON.stringify(s));
            assert.deepEqual(a.navegacoes, [], JSON.stringify(s));
            assert.equal(a.aviso(), null);
        }
    }
});

test('estado final durante a confirmação posterior: resultado real, sem navegar, com 401, corpo inválido, encerrada, outra sessão ou sucesso', async () => {
    for (const s of [S1, 'http401', 'http403', 'http500', 'rede', 'corpo-invalido', ENCERRADA, OUTRA] as Sessao[]) {
        const casos: Array<[number, RegExp]> = [[200, /concluída.*Não repita/], [500, /Resultado incerto/], [422, /recusou/]];
        for (const [status, texto] of casos) {
            const a: Amb = ambiente({ sessoes: [S1, s], alvo: { status, corpo: {} }, diagnostico: TROCA_PROVADA, aoLer: async (n) => { if (n === 1) await chegarAoFinal(a); } });
            const e = await erroDe(a.mod.adminFetch('/api/x', { method: 'POST' }));
            assert.equal(e.tipo, 'ENDERECO_EM_VERIFICACAO', JSON.stringify(s));
            assert.equal(e.enviado, true);
            assert.match(e.message, texto);
            assert.match(a.aviso()!, texto);
            assert.equal(a.envios(), 1);
            assert.deepEqual(a.navegacoes, [], JSON.stringify(s));
        }
        const l: Amb = ambiente({ sessoes: [S1, s], diagnostico: TROCA_PROVADA, aoLer: async (n) => { if (n === 1) await chegarAoFinal(l); } });
        const e = await erroDe(l.mod.adminFetch('/api/x'));
        assert.equal(e.tipo, 'ENDERECO_EM_VERIFICACAO');
        assert.equal(l.aviso(), null);
        assert.deepEqual(l.navegacoes, []);
    }
});

test('estado final vindo da consulta periódica enquanto a decisão perdeu a validade: não descarta', async () => {
    let uma = true;
    const a: Amb = ambiente({ sessoes: [S1, 'http403'], diagnostico: TROCA_PROVADA, aoDiagnostico: () => {
        if (!uma) return;
        uma = false;
        a.ctx.iniciarTrocaDeEmpresa();
        a.cli.iniciarAcompanhamento();
    } });
    const e = await erroDe(a.mod.adminFetch('/api/x', { method: 'POST' }));
    assert.equal(a.cli.enderecoFinal(), true);
    assert.equal(e.tipo, 'ENDERECO_EM_VERIFICACAO');
    assert.deepEqual(a.navegacoes, []);
});

test('decisão que perdeu a validade na confirmação prévia não deixa estado final', async () => {
    const a: Amb = ambiente({ sessoes: ['http403'], diagnostico: TROCA_PROVADA, aoDiagnostico: () => { a.ctx.iniciarTrocaDeEmpresa(); } });
    await erroDe(a.mod.adminFetch('/api/x'));
    await new Promise((r) => setImmediate(r));
    assert.equal(a.consultas(), 1);
    assert.equal(a.cli.enderecoFinal(), false);
});

test('409 da sessão antiga com a aba já final: recusa real, sem descarte, antes e depois de ler o corpo', async () => {
    let a: Amb;
    a = ambiente({ sessoes: [S1], alvo: RECUSA_409, diagnostico: TROCA_PROVADA, antesDoAlvo: async () => { await chegarAoFinal(a); } });
    let e = await erroDe(a.mod.adminFetch('/api/x', { method: 'POST' }));
    assert.equal(e.tipo, 'ENDERECO_EM_VERIFICACAO');
    assert.match(e.message, /recusou/);
    assert.deepEqual(a.navegacoes, []);
    a = ambiente({ sessoes: [S1], alvo: RECUSA_409, diagnostico: TROCA_PROVADA, aoLerCorpo: async () => { await chegarAoFinal(a); } });
    e = await erroDe(a.mod.adminFetch('/api/x', { method: 'POST' }));
    assert.equal(e.tipo, 'ENDERECO_EM_VERIFICACAO');
    assert.deepEqual(a.navegacoes, []);
    a = ambiente({ sessoes: [S1], alvo: RECUSA_409, diagnostico: [NAO_ARMAR] });
    e = await erroDe(a.mod.adminFetch('/api/x', { method: 'POST' }));
    assert.equal(e.tipo, 'RECUSADA_PELO_CONTEXTO');
    assert.equal(a.navegacoes.at(-1), 'replace:/admin/dashboard');
});

test('estado final no retorno da rota de senha, sem confirmação posterior: não entrega', async () => {
    const a: Amb = ambiente({ sessoes: [S1], alvo: { status: 409, corpo: { codigo: 'OUTRO' } }, diagnostico: TROCA_PROVADA, aoLerCorpo: async () => { await chegarAoFinal(a); } });
    const e = await erroDe(a.mod.adminFetch('/api/admin/perfil/senha', { method: 'POST' }));
    assert.equal(e.tipo, 'ENDERECO_EM_VERIFICACAO');
});

test('prazo fora do shell: falha, sucesso e nova falha abrem novo prazo e tiram o aviso neutro', async () => {
    const r = relogio();
    try {
        const a = ambiente({ sessoes: [S1, 'http500', S1, S1, S1, 'http500'], diagnostico: [consulta('ATIVA', true), 'rede'] });
        await a.armar();
        r.avancar(31000);
        await erroDe(a.mod.adminFetch('/api/x'));
        assert.equal(a.cli.estadoAviso(), 'SEM_RESPOSTA');
        r.avancar(10 * 60 * 1000);
        await a.mod.adminFetch('/api/x');
        assert.equal(a.cli.estadoAviso(), 'NENHUM');
        r.avancar(10 * 60 * 1000);
        const e = await erroDe(a.mod.adminFetch('/api/x'));
        assert.equal(e.tipo, 'ENDERECO_EM_VERIFICACAO');
        assert.equal(a.cli.estadoAviso(), 'SEM_RESPOSTA');
        assert.deepEqual(a.navegacoes, []);
    }
    finally { r.parar(); }
});

test('prazo: a confirmação prévia válida sozinha já registra a recuperação', async () => {
    const r = relogio();
    try {
        const a = ambiente({ sessoes: [S1, 'http500', S1, 'http500'], diagnostico: [consulta('ATIVA', true), 'rede'] });
        await a.armar();
        r.avancar(31000);
        await erroDe(a.mod.adminFetch('/api/x'));
        r.avancar(20 * 60 * 1000);
        const e = await erroDe(a.mod.adminFetch('/api/x'));
        assert.equal(e.tipo, 'ENDERECO_EM_VERIFICACAO');
        assert.deepEqual(a.navegacoes, []);
    }
    finally { r.parar(); }
});

test('prazo: a confirmação posterior válida registra a recuperação; contexto mudado não registra', async () => {
    const r = relogio();
    try {
        const a: Amb = ambiente({ sessoes: [S1, S1], diagnostico: [consulta('ATIVA', true), 'rede'], antesDoAlvo: async () => { r.avancar(31000); await a.cli.decidirFalhaSessao({ tipo: 'falha', telaCarregada: true, aindaValida: () => true }); assert.equal(a.cli.estadoAviso(), 'SEM_RESPOSTA'); } });
        await a.armar();
        await a.mod.adminFetch('/api/x');
        assert.equal(a.cli.estadoAviso(), 'NENHUM');

        const b: Amb = ambiente({ sessoes: [S1, OUTRA], diagnostico: [consulta('ATIVA', true), 'rede'], antesDoAlvo: async () => { r.avancar(31000); await b.cli.decidirFalhaSessao({ tipo: 'falha', telaCarregada: true, aindaValida: () => true }); } });
        await b.armar();
        const e = await erroDe(b.mod.adminFetch('/api/x'));
        assert.equal(e.tipo, 'CONTEXTO_MUDOU');
        assert.equal(b.cli.estadoAviso(), 'SEM_RESPOSTA');
    }
    finally { r.parar(); }
});

test('prazo: contexto mudado na confirmação prévia não registra recuperação', async () => {
    const r = relogio();
    try {
        const a = ambiente({ sessoes: [S1, S1, OUTRA], diagnostico: [consulta('ATIVA', true), 'rede'] });
        await a.armar();
        await a.mod.adminFetch('/api/x');
        r.avancar(31000);
        await a.cli.decidirFalhaSessao({ tipo: 'falha', telaCarregada: true, aindaValida: () => true });
        assert.equal(a.cli.estadoAviso(), 'SEM_RESPOSTA');
        const leituras = () => a.chamadas.filter((c) => c.url === '/api/admin/autenticacao').length;
        assert.equal(leituras(), 2);
        const e = await erroDe(a.mod.adminFetch('/api/x'));
        assert.equal(leituras(), 3, 'a sessão diferente foi lida na prévia');
        assert.equal(e.tipo, 'CONTEXTO_MUDOU');
        assert.equal(e.enviado, false);
        assert.equal(a.envios(), 1, 'só o primeiro pedido saiu');
        assert.equal(a.cli.estadoAviso(), 'SEM_RESPOSTA');
    }
    finally { r.parar(); }
});

test('reautenticação: POST concluído, 403 na confirmação com troca provada: sem descarte, sem repetir e sem dizer que saiu tudo', async () => {
    const a = ambiente({ sessoes: [S1, S1, 'http403'], alvo: RENOVACAO, diagnostico: TROCA_PROVADA });
    const r = await a.mod.reautenticarSessao('certa');
    assert.deepEqual(r, { ok: false, erro: a.mod.AVISO_RENOVACAO_EM_VERIFICACAO, senhaIncorreta: false });
    assert.equal(a.cli.enderecoFinal(), true);
    assert.equal(a.posts(), 1);
    assert.deepEqual(a.navegacoes, []);
    assert.match(a.aviso()!, /senha foi aceita/);
});

test('reautenticação: inconclusivo em aba armada mantém a tela; a sessão que voltar diferente cai na regra normal', async () => {
    const r = relogio();
    try {
        const a = ambiente({ sessoes: [S1, S1, 'http500', S2_MESMA], alvo: RENOVACAO, diagnostico: [consulta('ATIVA', true), 'rede'] });
        await a.armar();
        r.avancar(31000);
        const res = await a.mod.reautenticarSessao('certa');
        assert.equal(res.erro, a.mod.AVISO_RENOVACAO_EM_VERIFICACAO);
        assert.equal(a.cli.estadoAviso(), 'SEM_RESPOSTA');
        assert.deepEqual(a.navegacoes, []);
        const e = await erroDe(a.mod.adminFetch('/api/x'));
        assert.equal(e.tipo, 'CONTEXTO_MUDOU');
        assert.equal(a.navegacoes.at(-1), 'replace:/admin/dashboard');
    }
    finally { r.parar(); }
});

test('reautenticação: estado final durante a confirmação, qualquer que seja a leitura: sem descarte', async () => {
    for (const s of [S2_MESMA, 'http401', 'http500', ENCERRADA, OUTRA] as Sessao[]) {
        const a: Amb = ambiente({ sessoes: [S1, S1, s], alvo: RENOVACAO, diagnostico: TROCA_PROVADA, aoLer: async (n) => { if (n === 2) await chegarAoFinal(a); } });
        const res = await a.mod.reautenticarSessao('certa');
        assert.equal(res.erro, a.mod.AVISO_RENOVACAO_EM_VERIFICACAO, JSON.stringify(s));
        assert.deepEqual(a.navegacoes, [], JSON.stringify(s));
    }
});

test('reautenticação: final vindo da consulta periódica com a decisão inválida também não descarta', async () => {
    let uma = true;
    const a: Amb = ambiente({ sessoes: [S1, S1, 'http403'], alvo: RENOVACAO, diagnostico: TROCA_PROVADA, aoDiagnostico: () => {
        if (!uma) return;
        uma = false;
        a.ctx.iniciarTrocaDeEmpresa();
        a.cli.iniciarAcompanhamento();
    } });
    const res = await a.mod.reautenticarSessao('certa');
    assert.equal(res.erro, a.mod.AVISO_RENOVACAO_EM_VERIFICACAO);
    assert.deepEqual(a.navegacoes, []);
});

test('reautenticação: fora de migração e divergência comprovada seguem descartando', async () => {
    for (const [s, diagnostico] of [['http403', [consulta('ATIVA', true)]], ['http500', TROCA_PROVADA], ['http401', TROCA_PROVADA], [OUTRA, TROCA_PROVADA], [ENCERRADA, TROCA_PROVADA]] as Array<[Sessao, Passo[]]>) {
        const a = ambiente({ sessoes: [S1, S1, s], alvo: RENOVACAO, diagnostico });
        const r = await a.mod.reautenticarSessao('certa');
        assert.equal(r.ok, false, JSON.stringify(s));
        assert.match(r.erro!, /de forma inesperada/);
        assert.equal(a.navegacoes.at(-1), 'replace:/admin/dashboard', JSON.stringify(s));
        assert.equal(a.cli.enderecoFinal(), false);
    }
});

test('reautenticação: decisão que perdeu a validade segue o descarte de hoje', async () => {
    const a: Amb = ambiente({ sessoes: [S1, S1, 'http500'], alvo: RENOVACAO, diagnostico: [consulta('ATIVA', true), 'rede'], aoLer: async (n) => { if (n === 2) { a.ctx.iniciarTrocaDeEmpresa(); } } });
    await a.armar();
    const agora = relogio();
    agora.avancar(31000);
    try {
        const r = await a.mod.reautenticarSessao('certa');
        assert.match(r.erro!, /de forma inesperada/);
    }
    finally { agora.parar(); }
});

test('reautenticação concluída registra a recuperação; a aba final não pede nem envia a senha', async () => {
    const a = ambiente({ sessoes: [S1, S1, S2_MESMA], alvo: RENOVACAO, diagnostico: TROCA_PROVADA });
    assert.deepEqual(await a.mod.reautenticarSessao('certa'), { ok: true });
    assert.deepEqual(a.navegacoes, []);

    const b: Amb = ambiente({ sessoes: [OUTRA], alvo: RENOVACAO, diagnostico: TROCA_PROVADA, aoLer: async () => { await chegarAoFinal(b); } });
    const r = await b.mod.reautenticarSessao('certa');
    assert.match(r.erro!, /mudou de endereço. Nada foi enviado/);
    assert.equal(b.posts(), 0);
    assert.deepEqual(b.navegacoes, []);
});

test('reautenticação: leituras válidas tiram o aviso neutro, nas duas confirmações', async () => {
    const r = relogio();
    try {
                const inconclusivo = (x: () => Amb) => async () => { r.avancar(31000); await x().cli.decidirFalhaSessao({ tipo: 'falha', telaCarregada: true, aindaValida: () => true }); };
        const a: Amb = ambiente({ sessoes: [S1, S1, S2_MESMA], alvo: RENOVACAO, diagnostico: [consulta('ATIVA', true), 'rede'], antesDoAlvo: inconclusivo(() => a) });
        await a.armar();
        assert.deepEqual(await a.mod.reautenticarSessao('certa'), { ok: true });
        assert.equal(a.cli.estadoAviso(), 'NENHUM');
        // Primeira confirmação sem o adminFetch seguinte: fica registrada por ela mesma.
        const b: Amb = ambiente({ sessoes: [S1, 'http401'], alvo: RENOVACAO, diagnostico: [consulta('ATIVA', true), 'rede'] });
        await b.armar();
        r.avancar(31000);
        await b.cli.decidirFalhaSessao({ tipo: 'falha', telaCarregada: true, aindaValida: () => true });
        assert.equal(b.cli.estadoAviso(), 'SEM_RESPOSTA');
        await b.mod.reautenticarSessao('certa');
        assert.equal(b.cli.estadoAviso(), 'NENHUM');
    }
    finally { r.parar(); }
});

test('troca de empresa: aba final não envia, nem antes nem depois da confirmação prévia', async () => {
    const a = ambiente({ sessoes: [S1], diagnostico: TROCA_PROVADA });
    await chegarAoFinal(a);
    const e = await erroDe(a.mod.trocarEmpresaAtiva('B'));
    assert.match(e.message, /mudou de endereço. Nada foi alterado/);
    assert.equal(a.chamadas.filter((c) => c.url === '/api/admin/autenticacao').length, 0);
    for (const s of [S1, 'http401', ENCERRADA, OUTRA] as Sessao[]) {
        const b: Amb = ambiente({ sessoes: [s], diagnostico: TROCA_PROVADA, aoLer: async () => { await chegarAoFinal(b); } });
        const f = await erroDe(b.mod.trocarEmpresaAtiva('B'));
        assert.match(f.message, /mudou de endereço. Nada foi alterado/, JSON.stringify(s));
        assert.equal(b.posts(), 0);
        assert.deepEqual(b.navegacoes, [], JSON.stringify(s));
    }
});

test('troca de empresa: estado final com a resposta na mão: resultado real, sem login nem descarte', async () => {
    const casos: Array<[{ status: number; corpo: unknown }, RegExp]> = [[{ status: 200, corpo: { ok: true } }, /concluída/], [{ status: 401, corpo: {} }, /recusou/], [RECUSA_409, /recusou/], [{ status: 503, corpo: {} }, /Resultado incerto/]];
    for (const [alvo, texto] of casos) {
        const a: Amb = ambiente({ sessoes: [S1], alvo, diagnostico: TROCA_PROVADA, antesDoAlvo: async () => { await chegarAoFinal(a); } });
        const e = await erroDe(a.mod.trocarEmpresaAtiva('B'));
        assert.match(e.message, texto);
        assert.match(a.aviso()!, texto);
        assert.equal(a.posts(), 1);
        assert.deepEqual(a.navegacoes, []);
    }
    const b: Amb = ambiente({ sessoes: [S1], alvo: RECUSA_409, diagnostico: TROCA_PROVADA, aoLerCorpo: async () => { await chegarAoFinal(b); } });
    const e = await erroDe(b.mod.trocarEmpresaAtiva('B'));
    assert.match(e.message, /recusou/);
    assert.deepEqual(b.navegacoes, []);
});

test('troca de empresa: fora do estado final segue como hoje e registra a recuperação', async () => {
    const r = relogio();
    try {
        const a: Amb = ambiente({ sessoes: [S1], diagnostico: [consulta('ATIVA', true), 'rede'] });
        await a.armar();
        r.avancar(31000);
        await a.cli.decidirFalhaSessao({ tipo: 'falha', telaCarregada: true, aindaValida: () => true });
        assert.equal(a.cli.estadoAviso(), 'SEM_RESPOSTA');
        const res = await a.mod.trocarEmpresaAtiva('B');
        assert.equal(res.status, 200);
        assert.equal(a.cli.estadoAviso(), 'NENHUM');
        const b = ambiente({ sessoes: [S1], alvo: { status: 401, corpo: {} }, diagnostico: [NAO_ARMAR] });
        await erroDe(b.mod.trocarEmpresaAtiva('B'));
        assert.match(b.navegacoes.at(-1)!, /login/);
        const c = ambiente({ sessoes: [S1], alvo: RECUSA_409, diagnostico: [NAO_ARMAR] });
        await erroDe(c.mod.trocarEmpresaAtiva('B'));
        assert.equal(c.navegacoes.at(-1), 'replace:/admin/dashboard');
    }
    finally { r.parar(); }
});

test('aba já final: nem a confirmação da sessão é pedida', async () => {
    const a = ambiente({ sessoes: [S1], diagnostico: TROCA_PROVADA });
    await chegarAoFinal(a);
    const e = await erroDe(a.mod.adminFetch('/api/x'));
    assert.equal(e.tipo, 'ENDERECO_EM_VERIFICACAO');
    assert.equal(a.chamadas.filter((c) => c.url === '/api/admin/autenticacao').length, 0);
});

test('corpo lido depois da aba chegar ao final: a continuação do componente não acontece, com o resultado real', async () => {
    const casos: Array<[number, RegExp]> = [[200, /concluída.*Não repita/], [403, /recusou/], [500, /Resultado incerto/]];
    for (const [status, texto] of casos) {
        const a: Amb = ambiente({ sessoes: [S1, S1], alvo: { status, corpo: { ok: status === 200, data: { id: 'convite' } } }, diagnostico: TROCA_PROVADA, aoLerJson: async () => { await chegarAoFinal(a); } });
        const r = await a.mod.adminFetch('/api/x', { method: 'POST' });
        let continuou = false;
        const e = await erroDe(r.json().then(() => { continuou = true; }));
        assert.equal(continuou, false, String(status));
        assert.equal(e.tipo, 'ENDERECO_EM_VERIFICACAO');
        assert.equal(e.enviado, true);
        assert.match(e.message, texto);
        assert.match(a.aviso()!, texto);
        assert.deepEqual(a.cli.resultadosDaTelaMantida().length, 1);
        assert.deepEqual(a.navegacoes, []);
    }
});

test('leitura: corpo que chega depois do final não é entregue, e nada vira resultado de escrita', async () => {
    const a: Amb = ambiente({ sessoes: [S1, S1], diagnostico: TROCA_PROVADA, aoLerJson: async () => { await chegarAoFinal(a); } });
    const r = await a.mod.adminFetch('/api/x');
    const e = await erroDe(r.json());
    assert.equal(e.tipo, 'ENDERECO_EM_VERIFICACAO');
    assert.equal(a.aviso(), null);
    assert.deepEqual(a.cli.resultadosDaTelaMantida(), []);
});

test('proteção cobre as outras leituras, o clone e o corpo ilegível; sem o final, o corpo chega intacto', async () => {
    for (const metodo of ['text', 'blob', 'arrayBuffer', 'formData'] as const) {
        const a = ambiente({ sessoes: [S1, S1], diagnostico: TROCA_PROVADA });
        const r = await a.mod.adminFetch('/api/x');
        await chegarAoFinal(a);
        const e = await erroDe(r[metodo]());
        assert.equal(e.tipo, 'ENDERECO_EM_VERIFICACAO', metodo);
    }
    const c = ambiente({ sessoes: [S1, S1], diagnostico: TROCA_PROVADA });
    const copia = (await c.mod.adminFetch('/api/x')).clone();
    await chegarAoFinal(c);
    assert.equal((await erroDe(copia.json())).tipo, 'ENDERECO_EM_VERIFICACAO');

    const b: Amb = ambiente({ sessoes: [S1, S1], diagnostico: TROCA_PROVADA, aoLerJson: async () => { await chegarAoFinal(b); throw new SyntaxError('corpo inválido'); } });
    assert.equal((await erroDe((await b.mod.adminFetch('/api/x')).json())).tipo, 'ENDERECO_EM_VERIFICACAO');

    const d: Amb = ambiente({ sessoes: [S1, S1], diagnostico: TROCA_PROVADA, aoLerJson: async () => { throw new SyntaxError('corpo inválido'); } });
    const semFinal = await erroDe((await d.mod.adminFetch('/api/x')).json());
    assert.equal(semFinal.name, 'SyntaxError');

    const f = ambiente({ sessoes: [S1, S1], alvo: { status: 200, corpo: { ok: true, valor: 7 } }, diagnostico: TROCA_PROVADA });
    assert.deepEqual(await (await f.mod.adminFetch('/api/x')).clone().json(), { ok: true, valor: 7 });
    const g = ambiente({ sessoes: [S1, S1], alvo: { status: 200, corpo: { valor: 8 } }, diagnostico: TROCA_PROVADA });
    assert.deepEqual(await (await g.mod.adminFetch('/api/x')).json(), { valor: 8 });
    const h = ambiente({ sessoes: [S1], alvo: { status: 200, corpo: { valor: 9 } }, diagnostico: TROCA_PROVADA });
    assert.deepEqual(await (await h.mod.adminFetch('/api/admin/perfil/senha', { method: 'POST' })).json(), { valor: 9 });
});

test('senha: 200 com a aba final durante o corpo, e não falha de conexão', async () => {
    const a: Amb = ambiente({ sessoes: [S1], alvo: { status: 200, corpo: { ok: true } }, diagnostico: TROCA_PROVADA, aoLerJson: async () => { await chegarAoFinal(a); } });
    const r = await a.mod.adminFetch('/api/admin/perfil/senha', { method: 'POST' });
    const e = await erroDe(a.mod.lerCorpoOuNulo(r));
    assert.match(a.mod.mensagemDoEndereco(e)!, /concluída/);
    assert.match(a.cli.resultadosDaTelaMantida()[0]!, /concluída/);
});

test('leitor de corpo e mensagem: só o estado final é preservado', async () => {
    const a = ambiente({ sessoes: [S1, S1], diagnostico: TROCA_PROVADA });
    assert.equal(await a.mod.lerCorpoOuNulo(new Response('<html>')), null);
    assert.deepEqual(await a.mod.lerCorpoOuNulo(new Response('{"a":1}')), { a: 1 });
    assert.equal(a.mod.mensagemDoEndereco(new Error('outra')), null);
    assert.equal(a.mod.mensagemDoEndereco('texto'), null);
});

test('PerfilSenha, consentimento: mostram o resultado real e o corpo não é engolido', () => {
    const senha = readFileSync('components/admin/PerfilSenha.tsx', 'utf8');
    assert.match(senha, /const corpo = await lerCorpoOuNulo</);
    assert.match(senha, /catch \(falha\) \{[\s\S]{0,120}setErro\(mensagemDoEndereco\(falha\) \?\? 'Falha de conexão/);
    assert.match(readFileSync('components/admin/ConsentimentoAssistente.tsx', 'utf8'), /const corpo = await lerCorpoOuNulo</);
});

test('resultado da tela mantida: uma vez cada, avisa quem assina, e sai quando a sessão volta', async () => {
    const a = ambiente({ sessoes: [S1, 'http500'], diagnostico: [consulta('ATIVA', true), 'rede'] });
    await a.armar();
    const r = relogio();
    try {
        r.avancar(31000);
        await erroDe(a.mod.adminFetch('/api/x', { method: 'POST' }));
        assert.match(a.cli.resultadosDaTelaMantida()[0]!, /concluída/);
        await erroDe(a.mod.adminFetch('/api/x', { method: 'POST' }));
        a.cli.sessaoValida();
        assert.deepEqual(a.cli.resultadosDaTelaMantida(), []);
    }
    finally { r.parar(); }
    const f = ambiente({ sessoes: [S1, 'http403'], alvo: { status: 200, corpo: {} }, diagnostico: TROCA_PROVADA });
    await erroDe(f.mod.adminFetch('/api/x', { method: 'POST' }));
    const antes = f.cli.resultadosDaTelaMantida();
    assert.equal(antes.length, 1);
    f.cli.sessaoValida();
    assert.deepEqual(f.cli.resultadosDaTelaMantida(), antes, 'no estado final o resultado fica');
    const fonte = readFileSync('components/enderecos/AvisoEndereco.tsx', 'utf8');
    assert.match(fonte, /setResultados\(resultadosDaTelaMantida\(\)\)/);
    assert.equal(fonte.match(/\{doResultado\}/g)?.length, 2);
});

test('descarte central: com a aba final, nenhum caminho navega; resultado de escrita fica, descarte não', async () => {
    const a = ambiente({ sessoes: [S1], diagnostico: TROCA_PROVADA });
    await chegarAoFinal(a);
    a.ctx.reiniciarContextoEmpresa();
    a.ctx.reiniciarContextoEmpresa('a empresa mudou');
    assert.equal(a.aviso(), null);
    a.ctx.reiniciarContextoEmpresa('escrita concluída', undefined, 'escrita');
    assert.equal(a.aviso(), 'escrita concluída');
    assert.equal(a.ctx.registrarContextoEmpresa('s1', 'A'), true);
    assert.equal(a.ctx.registrarContextoEmpresa('s2', 'B'), false);
    assert.deepEqual(a.navegacoes, []);
    const b = ambiente({ sessoes: [S1], diagnostico: [NAO_ARMAR] });
    b.ctx.reiniciarContextoEmpresa();
    assert.equal(b.navegacoes.at(-1), 'replace:/admin/dashboard');
    assert.match(readFileSync('components/admin/AdminShell.tsx', 'utf8'), /kidmais-contexto-alterado'\) reiniciarContextoEmpresa\('A empresa ativa foi trocada/);
});

test('troca de empresa: final durante a leitura do corpo mantém recusa, incerteza e conclusão', async () => {
    const casos: Array<[number, RegExp]> = [[200, /concluída/], [403, /recusou/], [500, /Resultado incerto/]];
    for (const [status, texto] of casos) {
        const a: Amb = ambiente({ sessoes: [S1], alvo: { status, corpo: { ok: status === 200 } }, diagnostico: TROCA_PROVADA, aoLerJson: async () => { await chegarAoFinal(a); } });
        const res = await a.mod.trocarEmpresaAtiva('B');
        const e = await erroDe(res.json());
        assert.match(e.message, texto, String(status));
        assert.deepEqual(a.navegacoes, []);
    }
    assert.doesNotMatch(readFileSync('components/admin/AdminShell.tsx', 'utf8'), /AVISO_ESCRITA_EM_VERIFICACAO/);
});

test('reautenticação: final durante o corpo do POST: senha aceita ou recusa real, sem continuar', async () => {
    const a: Amb = ambiente({ sessoes: [S1, S1], alvo: RENOVACAO, diagnostico: TROCA_PROVADA, aoLerJson: async () => { await chegarAoFinal(a); } });
    const r = await a.mod.reautenticarSessao('certa');
    assert.deepEqual(r, { ok: false, erro: a.mod.AVISO_RENOVACAO_EM_VERIFICACAO, senhaIncorreta: false });
    assert.equal(a.cli.resultadosDaTelaMantida()[0], a.mod.AVISO_RENOVACAO_EM_VERIFICACAO);
    assert.deepEqual(a.navegacoes, []);
    const b: Amb = ambiente({ sessoes: [S1, S1], alvo: { status: 500, corpo: {} }, diagnostico: TROCA_PROVADA, aoLerJson: async () => { await chegarAoFinal(b); } });
    const q = await b.mod.reautenticarSessao('certa');
    assert.match(q.erro!, /Resultado incerto/);
});

test('cadastro: aba final não envia nem navega depois de criar a empresa', () => {
    const fonte = readFileSync('app/cadastro/empresa/page.tsx', 'utf8');
    assert.match(fonte, /async function postar\(url: string, corpo: unknown\) \{[\s\S]{0,120}if \(enderecoFinal\(\)\) throw/);
    assert.match(fonte, /if \(enderecoFinal\(\)\) \{ setOcupado\(false\); setCriadaSemAbrir\(true\); return; \}\s*window\.location\.replace\('\/admin\/inicio'\)/);
});

// ---------------------------------------------------------------- r4: status/ok protegidos e resultado da última escrita
const ULTIMA = /última operação enviada foi concluída/;

test('fora de migração, a resposta entregue segue igual: status, ok, corpo, clone e leitura repetida', async () => {
    const a = ambiente({ sessoes: [S1, S1], alvo: { status: 201, corpo: { ok: true, n: 1 } }, diagnostico: [NAO_ARMAR] });
    const r = await a.mod.adminFetch('/api/x', { method: 'POST' });
    assert.equal(r.status, 201);
    assert.equal(r.status, 201);
    assert.equal(r.ok, true);
    const c = r.clone();
    assert.equal(c.status, 201);
    assert.deepEqual(await c.json(), { ok: true, n: 1 });
    assert.deepEqual(await r.json(), { ok: true, n: 1 });
    assert.deepEqual(a.navegacoes, []);
    assert.deepEqual(a.cli.resultadosDaTelaMantida(), []);
});

test('aba chega ao estado final depois da entrega: status e ok falham com o resultado real, antes de qualquer corpo', async () => {
    for (const campo of ['status', 'ok'] as const) {
        const a = ambiente({ sessoes: [S1, S1], alvo: { status: 401, corpo: { ok: false } }, diagnostico: TROCA_PROVADA });
        const r = await a.mod.adminFetch('/api/x', { method: 'POST' });
        await chegarAoFinal(a);
        let erro: (Error & { tipo?: string }) | null = null;
        try { void r[campo]; } catch (e) { erro = e as Error & { tipo?: string }; }
        assert.equal(erro?.tipo, 'ENDERECO_EM_VERIFICACAO', campo);
        assert.match(erro!.message, /o servidor recusou/);
        assert.deepEqual(a.navegacoes, []);
    }
});

test('o clone entregue também protege status e ok', async () => {
    const a = ambiente({ sessoes: [S1, S1], diagnostico: TROCA_PROVADA });
    const c = (await a.mod.adminFetch('/api/x')).clone();
    await chegarAoFinal(a);
    assert.throws(() => c.status, /Os dados recebidos não foram exibidos/);
    assert.throws(() => c.ok, /Os dados recebidos não foram exibidos/);
});

const fechamento = () => carregarModulo('components/admin/fechamento-preparacao.ts', {}, new Map()) as unknown as {
    reconciliar: (b: unknown, c: string, o: string) => Promise<{ tipo: string; erro?: string }>;
    enviarPreparado: (b: unknown, e: unknown) => Promise<{ tipo: string; erro?: string }>;
};
const OP = '00000000-0000-4000-8000-000000000001';
/** Decisão concorrente marca o final entre a resolução de adminFetch e a continuação do helper (reprodução do parecer da r3). */
const buscadorComFinal = (a: Amb) => async (u: string, i: RequestInit) => {
    const r = await a.mod.adminFetch(u, i);
    await chegarAoFinal(a);
    return r;
};

test('fechamento preparado: enviar com 401 e aba final falha com o resultado real, sem SESSAO', async () => {
    const a = ambiente({ sessoes: [S1, S1], alvo: { status: 401, corpo: { ok: false } }, diagnostico: TROCA_PROVADA });
    const e = await erroDe(fechamento().enviarPreparado(buscadorComFinal(a), { clienteId: 'c', referencia: { operacaoId: OP, versao: 1, payloadHash: 'h' }, formulario: {}, semPreparacao: false }));
    assert.equal(e.tipo, 'ENDERECO_EM_VERIFICACAO');
    assert.match(e.message, /o servidor recusou/);
    assert.deepEqual(a.navegacoes, []);
});

test('escrita confirmada: a atualização posterior encontra o estado final e o sucesso fica no aviso e no registro', async () => {
    let chegar: (() => Promise<void>) | null = null;
    const a: Amb = ambiente({ sessoes: [S1], diagnostico: TROCA_PROVADA, aoLer: async (n) => { if (n === 3) await chegar?.(); } });
    const r = await a.mod.adminFetch('/api/x', { method: 'POST' });
    assert.deepEqual(await r.json(), { ok: true });
    chegar = async () => { await chegarAoFinal(a); };
    const e = await erroDe(a.mod.adminFetch('/api/x'));
    assert.equal(e.tipo, 'ENDERECO_EM_VERIFICACAO');
    assert.match(a.cli.resultadosDaTelaMantida()[0], ULTIMA);
    assert.match(a.aviso()!, ULTIMA);
    assert.deepEqual(a.navegacoes, []);
    assert.equal(a.envios(), 2);
});

test('escrita confirmada: o estado final antes de sair a atualização também guarda o sucesso', async () => {
    const a = ambiente({ sessoes: [S1], diagnostico: TROCA_PROVADA });
    await (await a.mod.adminFetch('/api/x', { method: 'POST' })).json();
    await chegarAoFinal(a);
    const e = await erroDe(a.mod.adminFetch('/api/x'));
    assert.equal(e.enviado, false);
    assert.match(a.aviso()!, ULTIMA);
    assert.equal(a.cli.resultadosDaTelaMantida().length, 1);
});

test('resultado entregue não aparece enquanto a aba não chega ao estado final', async () => {
    const a = ambiente({ sessoes: [S1], diagnostico: TROCA_PROVADA });
    await a.mod.adminFetch('/api/x', { method: 'POST' });
    assert.deepEqual(a.cli.resultadosDaTelaMantida(), []);
    assert.equal(a.aviso(), null);
});

test('resultado anotado usa o resultado real: recusa, 5xx e corpo com ok:false nunca viram "concluída"', async () => {
    const casos: Array<[number, unknown, RegExp]> = [[422, { ok: false }, /o servidor recusou/], [500, {}, /Resultado incerto/], [200, { ok: false }, /o servidor recusou/]];
    for (const [status, corpo, texto] of casos) {
        const a = ambiente({ sessoes: [S1], alvo: { status, corpo }, diagnostico: TROCA_PROVADA });
        await (await a.mod.adminFetch('/api/x', { method: 'POST' })).json();
        await chegarAoFinal(a);
        assert.equal(a.cli.resultadosDaTelaMantida().length, 1, String(status));
        assert.match(a.cli.resultadosDaTelaMantida()[0], texto);
        assert.doesNotMatch(a.aviso()!, /concluída antes/);
    }
});

test('leitura entregue não vira resultado de escrita', async () => {
    const a = ambiente({ sessoes: [S1], diagnostico: TROCA_PROVADA });
    await (await a.mod.adminFetch('/api/x')).json();
    await chegarAoFinal(a);
    assert.deepEqual(a.cli.resultadosDaTelaMantida(), []);
    assert.equal(a.aviso(), null);
});

test('POST com falha de rede depois do estado final: resultado incerto no aviso e no registro', async () => {
    const a: Amb = ambiente({ sessoes: [S1], diagnostico: TROCA_PROVADA, antesDoAlvo: async () => { await chegarAoFinal(a); throw new TypeError('fetch failed'); } });
    const e = await erroDe(a.mod.adminFetch('/api/x', { method: 'POST' }));
    assert.equal(e.tipo, 'RESULTADO_INCERTO');
    assert.match(a.cli.resultadosDaTelaMantida()[0], /Resultado incerto/);
    assert.match(a.aviso()!, /Resultado incerto/);
    assert.deepEqual(a.navegacoes, []);
});

test('POST com falha de rede e o estado final só depois: o resultado incerto também aparece', async () => {
    const a = ambiente({ sessoes: [S1], diagnostico: TROCA_PROVADA, antesDoAlvo: async () => { throw new TypeError('fetch failed'); } });
    await erroDe(a.mod.adminFetch('/api/x', { method: 'POST' }));
    assert.deepEqual(a.cli.resultadosDaTelaMantida(), []);
    await chegarAoFinal(a);
    assert.match(a.cli.resultadosDaTelaMantida()[0], /Resultado incerto/);
});

test('GET com falha de rede no estado final não inventa resultado', async () => {
    const a: Amb = ambiente({ sessoes: [S1], diagnostico: TROCA_PROVADA, antesDoAlvo: async () => { await chegarAoFinal(a); throw new TypeError('fetch failed'); } });
    const e = await erroDe(a.mod.adminFetch('/api/x'));
    assert.equal(e.tipo, 'REDE');
    assert.deepEqual(a.cli.resultadosDaTelaMantida(), []);
});

test('troca de empresa com falha de rede e estado final: resultado incerto no aviso', async () => {
    const g = globalThis as unknown as { fetch: (u: string, i?: RequestInit) => Promise<Response> };
    const a = ambiente({ sessoes: [S1], diagnostico: TROCA_PROVADA });
    const original = g.fetch;
    g.fetch = async (u, i) => {
        if (u === '/api/admin/autenticacao' && i?.method === 'POST') { await chegarAoFinal(a); throw new TypeError('fetch failed'); }
        return original(u, i);
    };
    await assert.rejects(a.mod.trocarEmpresaAtiva('B'), /Não foi possível confirmar a troca/);
    assert.match(a.cli.resultadosDaTelaMantida()[0], /Resultado incerto/);
    assert.deepEqual(a.navegacoes, []);
});

test('renovação e troca de senha não viram "última operação": quem chamou confirma o resultado', async () => {
    const a = ambiente({ sessoes: [S1, S1, S2_MESMA], alvo: RENOVACAO, diagnostico: TROCA_PROVADA });
    assert.deepEqual(await a.mod.reautenticarSessao('certa'), { ok: true });
    await chegarAoFinal(a);
    assert.deepEqual(a.cli.resultadosDaTelaMantida(), []);
});

test('fonte: nenhuma navegação depois de uma espera ignora o estado final', () => {
    const ler = (f: string) => readFileSync(f, 'utf8');
    assert.match(ler('components/admin/FechamentoAdminWizard.tsx'), /if \(d\.tipo === 'SESSAO'\) \{[\s\S]{0,160}if \(enderecoFinal\(\)\) return setErro\(AVISO_ENDERECO_MUDOU\);\s*router\.replace\('\/admin\/login'\)/);
    assert.match(ler('components/festas/FestaConsole.tsx'), /if\(!enderecoFinal\(\)\)router\.push\('\/admin\/contratos\?contratoId='/);
    assert.match(ler('components/festas/FestaConsole.tsx'), /mode==='invalidar'&&!enderecoFinal\(\)\)router\.push/);
    assert.match(ler('components/festas/FestaConsole.tsx'), /setErro\(mensagemDoEndereco\(falha\)\?\?'Não foi possível confirmar o salvamento/);
    assert.match(ler('components/admin/ContratoAdmin.tsx'), /if\(enderecoFinal\(\)\)return;\s*setCid\(''\)/);
    assert.equal(ler('components/admin/ContratoImportado.tsx').match(/if \(!enderecoFinal\(\)\) router\.replace\(/g)?.length, 2);
    assert.match(ler('components/admin/importacao/ImportacaoReal.tsx'), /if \(!enderecoFinal\(\)\) router\.replace\('\/admin\/contratos/);
    assert.match(ler('components/admin/inteligencia/PerguntarKidmais.tsx'), /!abortar\.signal\.aborted && !enderecoFinal\(\) && resultado\.tipo/);
    assert.match(ler('components/admin/ConsentimentoAssistente.tsx'), /setErro\(mensagemDoEndereco\(falha\) \?\? 'Resultado incerto/);
});

// ---------------------------------------------------------------- r5: resultado decidido na chegada, ordem de envio, consultas
const PREPARACOES = '/api/admin/inteligencia/preparacoes';
const IMPORTACOES = '/api/admin/inteligencia/importacoes';
const post = (corpo?: object): RequestInit => ({ method: 'POST', ...(corpo ? { body: JSON.stringify(corpo) } : {}) });

test('fechamento preparado: reconciliar com 401 ou 200 e aba final dá INCERTO, sem login e sem resultado de escrita', async () => {
    for (const alvo of [{ status: 401, corpo: { ok: false } }, { status: 200, corpo: { ok: true, data: { estado: 'ABERTA' } } }]) {
        const a = ambiente({ sessoes: [S1], alvo, diagnostico: TROCA_PROVADA });
        assert.equal((await fechamento().reconciliar(buscadorComFinal(a), 'c', OP)).tipo, 'INCERTO');
        assert.deepEqual(a.navegacoes, []);
        assert.deepEqual(a.cli.resultadosDaTelaMantida(), []);
        assert.equal(a.aviso(), null);
    }
});

test('5xx com ok:false continua incerto, nunca recusa', async () => {
    const a = ambiente({ sessoes: [S1], alvo: { status: 500, corpo: { ok: false } }, diagnostico: TROCA_PROVADA });
    await (await a.mod.adminFetch('/api/x', post())).json();
    await chegarAoFinal(a);
    assert.equal(a.cli.resultadosDaTelaMantida().length, 1);
    assert.match(a.cli.resultadosDaTelaMantida()[0], /Resultado incerto/);
    assert.doesNotMatch(a.aviso()!, /recusou/);
});

test('HTTP 200 com ok:false: recusa em todo caminho, mesmo com o corpo sem ler ou lido pelo clone', async () => {
    const roteiro = { sessoes: [S1], alvo: { status: 200, corpo: { ok: false } }, diagnostico: TROCA_PROVADA };
    const semLer = ambiente(roteiro);
    await semLer.mod.adminFetch('/api/x', post());
    await chegarAoFinal(semLer);
    assert.match(semLer.cli.resultadosDaTelaMantida()[0], /o servidor recusou/);

    const peloClone = ambiente(roteiro);
    await (await peloClone.mod.adminFetch('/api/x', post())).clone().json();
    await chegarAoFinal(peloClone);
    assert.match(peloClone.cli.resultadosDaTelaMantida()[0], /o servidor recusou/);
});

test('HTTP 200 com ok:false e final durante a leitura do corpo pelo componente: erro, aviso e registro dizem recusa', async () => {
    let chegar: (() => Promise<void>) | null = null;
    const a: Amb = ambiente({ sessoes: [S1], alvo: { status: 200, corpo: { ok: false } }, diagnostico: TROCA_PROVADA, aoLerJson: async () => { await chegar?.(); } });
    const r = await a.mod.adminFetch('/api/x', post());
    chegar = () => chegarAoFinal(a).then(() => undefined);
    const e = await erroDe(r.json());
    assert.match(e.message, /o servidor recusou/);
    assert.deepEqual(a.cli.resultadosDaTelaMantida().length, 1);
    assert.match(a.cli.resultadosDaTelaMantida()[0], /o servidor recusou/);
    assert.doesNotMatch(a.aviso()!, /foi concluída antes/);
});

test('HTTP 200 com ok:false e final enquanto o resultado é lido na chegada: recusa, sem entregar', async () => {
    let arquivado = false;
    const a: Amb = ambiente({ sessoes: [S1], alvo: { status: 200, corpo: { ok: false } }, diagnostico: TROCA_PROVADA, aoLerCorpo: async () => { if (!arquivado) { arquivado = true; await chegarAoFinal(a); } } });
    const e = await erroDe(a.mod.adminFetch('/api/x', post()));
    assert.equal(e.tipo, 'ENDERECO_EM_VERIFICACAO');
    assert.match(e.message, /o servidor recusou/);
    assert.equal(a.cli.resultadosDaTelaMantida().length, 1);
});

test('corpo fora de JSON não é lido na chegada', async () => {
    const a = ambiente({ sessoes: [S1], diagnostico: TROCA_PROVADA });
    const g = globalThis as unknown as { fetch: (u: string, i?: RequestInit) => Promise<Response> };
    const original = g.fetch;
    let clones = 0;
    g.fetch = async (u, i) => {
        if (u !== '/api/pdf') return original(u, i);
        const r = new Response('%PDF', { headers: { 'content-type': 'application/pdf' } });
        const clonar = r.clone.bind(r);
        r.clone = () => { clones += 1; return clonar(); };
        return r;
    };
    await a.mod.adminFetch('/api/pdf', post());
    assert.equal(clones, 0);
});

test('resposta com corpo ainda sem ler continua inteira para quem chamou', async () => {
    const a = ambiente({ sessoes: [S1], alvo: { status: 200, corpo: { ok: true, n: 7 } }, diagnostico: [NAO_ARMAR] });
    assert.deepEqual(await (await a.mod.adminFetch('/api/x', post())).json(), { ok: true, n: 7 });
});

test('só escrita com sucesso HTTP tem o corpo lido na chegada: GET, consulta e recusa não', async () => {
    const pedidos: Array<[string, RequestInit | undefined, { status: number; corpo: unknown }]> = [
        ['/api/x', undefined, { status: 200, corpo: { ok: true } }],
        [IMPORTACOES, post({ acao: 'estado' }), { status: 200, corpo: { ok: true } }],
        ['/api/x', post(), { status: 422, corpo: { ok: false } }],
        ['/api/x', post(), { status: 500, corpo: { ok: false } }],
    ];
    for (const [url, init, alvo] of pedidos) {
        let leituras = 0;
        const a = ambiente({ sessoes: [S1], alvo, diagnostico: [NAO_ARMAR], aoLerCorpo: async () => { leituras += 1; } });
        await a.mod.adminFetch(url, init);
        assert.equal(leituras, 0, url + ' ' + alvo.status);
    }
    let leituras = 0;
    const a = ambiente({ sessoes: [S1], diagnostico: [NAO_ARMAR], aoLerCorpo: async () => { leituras += 1; } });
    await a.mod.adminFetch('/api/x', post());
    assert.equal(leituras, 1);
});

test('HTTP 200 com ok:false: quem chamou continua vendo o status e o ok reais', async () => {
    const a = ambiente({ sessoes: [S1], alvo: { status: 200, corpo: { ok: false } }, diagnostico: [NAO_ARMAR] });
    const r = await a.mod.adminFetch('/api/x', post());
    assert.equal(r.ok, true);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: false });
});

test('resposta antiga não passa por cima da falha de rede da escrita mais recente', async () => {
    const g = globalThis as unknown as { fetch: (u: string, i?: RequestInit) => Promise<Response> };
    const a = ambiente({ sessoes: [S1], alvo: { status: 200, corpo: { ok: false } }, diagnostico: TROCA_PROVADA });
    const antiga = await a.mod.adminFetch('/api/x', post());
    const original = g.fetch;
    g.fetch = async (u, i) => { if (u === '/api/y') throw new TypeError('fetch failed'); return original(u, i); };
    await erroDe(a.mod.adminFetch('/api/y', post()));
    await antiga.json();
    await chegarAoFinal(a);
    assert.equal(a.cli.resultadosDaTelaMantida().length, 1);
    assert.match(a.cli.resultadosDaTelaMantida()[0], /Resultado incerto/);
});

test('escrita mais antiga que responde depois não vira a "última operação"', async () => {
    const g = globalThis as unknown as { fetch: (u: string, i?: RequestInit) => Promise<Response> };
    const a = ambiente({ sessoes: [S1], diagnostico: TROCA_PROVADA });
    const original = g.fetch;
    let liberar!: () => void;
    const segura = new Promise<void>((r) => { liberar = r; });
    g.fetch = async (u, i) => {
        if (u === '/api/lenta') { await segura; return original('/api/x', i); }
        if (u === '/api/y') throw new TypeError('fetch failed');
        return original(u, i);
    };
    const lenta = a.mod.adminFetch('/api/lenta', post());
    await new Promise((r) => setImmediate(r));
    await erroDe(a.mod.adminFetch('/api/y', post()));
    liberar();
    await lenta;
    await chegarAoFinal(a);
    assert.equal(a.cli.resultadosDaTelaMantida().length, 1);
    assert.match(a.cli.resultadosDaTelaMantida()[0], /Resultado incerto/);
});

test('com a aba já final, a falha de um envio anterior também fica registrada', async () => {
    const g = globalThis as unknown as { fetch: (u: string, i?: RequestInit) => Promise<Response> };
    const a = ambiente({ sessoes: [S1], diagnostico: TROCA_PROVADA });
    const original = g.fetch;
    let falhar!: () => void;
    const segura = new Promise<void>((_, rejeitar) => { falhar = () => rejeitar(new TypeError('fetch failed')); });
    let liberar!: () => void;
    const seguraB = new Promise<void>((r) => { liberar = r; });
    g.fetch = async (u, i) => {
        if (u === '/api/a') { await segura; }
        if (u === '/api/b') { await seguraB; return original('/api/x', i); }
        return original(u, i);
    };
    const pa = erroDe(a.mod.adminFetch('/api/a', post()));
    await new Promise((r) => setImmediate(r));
    const pb = erroDe(a.mod.adminFetch('/api/b', post()));
    await new Promise((r) => setImmediate(r));
    await chegarAoFinal(a);
    falhar();
    await pa;
    assert.match(a.cli.resultadosDaTelaMantida()[0], /Resultado incerto/);
    liberar();
    await pb;
});

test('novo envio apaga a anotação anterior antes de sair', async () => {
    const a: Amb = ambiente({ sessoes: [S1], alvo: { status: 422, corpo: { ok: false } }, diagnostico: TROCA_PROVADA });
    await a.mod.adminFetch('/api/x', post());
    const g = globalThis as unknown as { fetch: (u: string, i?: RequestInit) => Promise<Response> };
    const original = g.fetch;
    let liberar!: () => void;
    const segura = new Promise<void>((r) => { liberar = r; });
    g.fetch = async (u, i) => {
        if (u === '/api/nova') { await segura; return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } }); }
        return original(u, i);
    };
    const nova = a.mod.adminFetch('/api/nova', post());
    await new Promise((r) => setImmediate(r));
    await chegarAoFinal(a);
    assert.deepEqual(a.cli.resultadosDaTelaMantida(), []);
    liberar();
    await erroDe(nova);
    assert.equal(a.cli.resultadosDaTelaMantida().length, 1);
    assert.match(a.cli.resultadosDaTelaMantida()[0], /concluída/);
});

test('consulta entregue não anota nada e não substitui recusa nem sucesso', async () => {
    for (const [alvo, texto] of [[{ status: 422, corpo: { ok: false } }, /o servidor recusou/], [{ status: 200, corpo: { ok: true } }, ULTIMA]] as const) {
        const a: Amb = ambiente({ sessoes: [S1], alvo, diagnostico: TROCA_PROVADA });
        await a.mod.adminFetch('/api/x', post());
        await a.mod.adminFetch(IMPORTACOES, post({ acao: 'estado' }));
        await chegarAoFinal(a);
        assert.equal(a.cli.resultadosDaTelaMantida().length, 1);
        assert.match(a.cli.resultadosDaTelaMantida()[0], texto);
    }
});

test('consulta sozinha não produz resultado; com a aba final, o erro é de consulta e nada é registrado', async () => {
    const a = ambiente({ sessoes: [S1], alvo: { status: 200, corpo: { ok: true } }, diagnostico: TROCA_PROVADA });
    const r = await a.mod.adminFetch(PREPARACOES, post({ acao: 'situacao' }));
    await chegarAoFinal(a);
    assert.deepEqual(a.cli.resultadosDaTelaMantida(), []);
    assert.equal(a.aviso(), null);
    assert.throws(() => r.status, /antes de concluir esta consulta/);
    assert.deepEqual(a.cli.resultadosDaTelaMantida(), []);
});

test('consulta com falha de rede não vira resultado incerto no aviso, e o erro do componente segue igual', async () => {
    const a = ambiente({ sessoes: [S1], diagnostico: TROCA_PROVADA, antesDoAlvo: async () => { throw new TypeError('fetch failed'); } });
    const e = await erroDe(a.mod.adminFetch(IMPORTACOES, post({ acao: 'estado' })));
    assert.equal(e.tipo, 'RESULTADO_INCERTO');
    await chegarAoFinal(a);
    assert.deepEqual(a.cli.resultadosDaTelaMantida(), []);
});

test('consulta com falha de rede não apaga a anotação da escrita anterior', async () => {
    const g = globalThis as unknown as { fetch: (u: string, i?: RequestInit) => Promise<Response> };
    const a = ambiente({ sessoes: [S1], diagnostico: TROCA_PROVADA });
    await a.mod.adminFetch('/api/x', post());
    const original = g.fetch;
    g.fetch = async (u, i) => { if (u === IMPORTACOES) throw new TypeError('fetch failed'); return original(u, i); };
    await erroDe(a.mod.adminFetch(IMPORTACOES, post({ acao: 'listar' })));
    await chegarAoFinal(a);
    assert.match(a.cli.resultadosDaTelaMantida()[0], ULTIMA);
});

test('helpers reais de consulta: verificarImportacao não produz "última operação"', async () => {
    const a = ambiente({ sessoes: [S1], alvo: { status: 200, corpo: { ok: true, data: { habilitado: true } } }, diagnostico: TROCA_PROVADA });
    const mod = carregarModulo('components/admin/importacao/cliente-importacao.ts', {}, new Map()) as unknown as { verificarImportacao: (b: unknown) => Promise<{ ok: boolean }> };
    assert.equal((await mod.verificarImportacao(a.mod.adminFetch)).ok, true);
    await chegarAoFinal(a);
    assert.deepEqual(a.cli.resultadosDaTelaMantida(), []);
});

test('renovação não apaga a anotação da escrita anterior', async () => {
    const a = ambiente({ sessoes: [S1, S1, S1, S1, S2_MESMA], alvo: RENOVACAO, diagnostico: TROCA_PROVADA });
    await a.mod.adminFetch('/api/x', post());
    assert.deepEqual(await a.mod.reautenticarSessao('certa'), { ok: true });
    await chegarAoFinal(a);
    assert.match(a.cli.resultadosDaTelaMantida()[0], ULTIMA);
});

test('troca de empresa: 200 com ok:false e estado final viram recusa, e o corpo fica protegido', async () => {
    const g = globalThis as unknown as { fetch: (u: string, i?: RequestInit) => Promise<Response> };
    const a = ambiente({ sessoes: [S1], diagnostico: TROCA_PROVADA });
    const original = g.fetch;
    g.fetch = async (u, i) => {
        if (u === '/api/admin/autenticacao' && i?.method === 'POST') return new Response('{"ok":false}', { headers: { 'content-type': 'application/json' } });
        return original(u, i);
    };
    const r = await a.mod.trocarEmpresaAtiva('B');
    await chegarAoFinal(a);
    assert.throws(() => r.ok, /o servidor recusou/);
});

// ---------------------------------------------------------------- r6: identidade do envio, troca de empresa, conversa
const CONVERSA = '/api/admin/inteligencia/conversa';
const JSON_H = { 'content-type': 'application/json' };
const emEspera = () => { let liberar!: () => void; const espera = new Promise<void>((r) => { liberar = r; }); return { liberar, espera }; };
const proximoCiclo = () => new Promise((r) => setImmediate(r));
type G = { fetch: (u: string, i?: RequestInit) => Promise<Response> };
/** Troca o que um endereço responde, mantendo o roteiro para o resto. */
function responder(mapa: Record<string, (i?: RequestInit) => Promise<Response>>) {
    const g = globalThis as unknown as G;
    const original = g.fetch;
    g.fetch = async (u, i) => (mapa[u] && (i?.method ?? 'GET') !== 'GET' ? mapa[u](i) : original(u, i));
}
const respostaJson = (corpo: unknown, status = 200) => new Response(JSON.stringify(corpo), { status, headers: JSON_H });

test('resposta anterior lida com a aba final e outra escrita em voo: fala só dela e não entra no aviso', async () => {
    const a = ambiente({ sessoes: [S1], diagnostico: TROCA_PROVADA });
    const anterior = await a.mod.adminFetch('/api/x', post());
    const copia = anterior.clone();
    const b = emEspera();
    responder({ '/api/b': async () => { await b.espera; return respostaJson({ ok: true }, 422); } });
    const emVoo = erroDe(a.mod.adminFetch('/api/b', post()));
    await proximoCiclo();
    await chegarAoFinal(a);
    assert.deepEqual(a.cli.resultadosDaTelaMantida(), []);
    const e = await erroDe(anterior.json());
    assert.match(e.message, /Esta operação foi concluída/);
    assert.doesNotMatch(e.message, /última/);
    assert.deepEqual(a.cli.resultadosDaTelaMantida(), []);
    assert.equal(a.aviso(), null);
    assert.throws(() => anterior.status, /Esta operação foi concluída/);
    assert.throws(() => copia.ok, /Esta operação foi concluída/);
    b.liberar();
    await emVoo;
    assert.equal(a.cli.resultadosDaTelaMantida().length, 1);
    assert.match(a.cli.resultadosDaTelaMantida()[0], /o servidor recusou/);
});

test('resposta anterior recusada mantém o próprio resultado e também fica fora do aviso', async () => {
    const a = ambiente({ sessoes: [S1], alvo: { status: 422, corpo: { ok: false } }, diagnostico: TROCA_PROVADA });
    const anterior = await a.mod.adminFetch('/api/x', post());
    const b = emEspera();
    responder({ '/api/b': async () => { await b.espera; return respostaJson({ ok: true }); } });
    const emVoo = erroDe(a.mod.adminFetch('/api/b', post()));
    await proximoCiclo();
    await chegarAoFinal(a);
    assert.match((await erroDe(anterior.json())).message, /o servidor recusou/);
    assert.deepEqual(a.cli.resultadosDaTelaMantida(), []);
    b.liberar();
    await emVoo;
});

test('resposta do último envio, lida com a aba final, continua falando como a última', async () => {
    const a = ambiente({ sessoes: [S1], diagnostico: TROCA_PROVADA });
    const r = await a.mod.adminFetch('/api/x', post());
    await chegarAoFinal(a);
    assert.match((await erroDe(r.json())).message, ULTIMA);
    assert.equal(a.cli.resultadosDaTelaMantida().length, 1);
});

test('troca de empresa entregue e consumida antes do final: resultado real no aviso', async () => {
    const casos: Array<[number, unknown, RegExp]> = [[200, { ok: true }, ULTIMA], [422, { ok: false }, /o servidor recusou/], [500, { ok: false }, /Resultado incerto/], [200, { ok: false }, /o servidor recusou/]];
    for (const [status, corpo, texto] of casos) {
        const a = ambiente({ sessoes: [S1], diagnostico: TROCA_PROVADA });
        responder({ '/api/admin/autenticacao': async () => respostaJson(corpo, status) });
        await (await a.mod.trocarEmpresaAtiva('B')).json();
        assert.deepEqual(a.cli.resultadosDaTelaMantida(), []);
        await chegarAoFinal(a);
        assert.equal(a.cli.resultadosDaTelaMantida().length, 1, String(status));
        assert.match(a.cli.resultadosDaTelaMantida()[0], texto);
        assert.match(a.aviso()!, texto);
    }
});

test('troca de empresa superada por outra escrita não fala como a última', async () => {
    const a = ambiente({ sessoes: [S1], diagnostico: TROCA_PROVADA });
    responder({ '/api/admin/autenticacao': async () => respostaJson({ ok: true }) });
    const troca = await a.mod.trocarEmpresaAtiva('B');
    const b = emEspera();
    responder({ '/api/b': async () => { await b.espera; return respostaJson({ ok: true }); } });
    const emVoo = erroDe(a.mod.adminFetch('/api/b', post()));
    await proximoCiclo();
    await chegarAoFinal(a);
    assert.throws(() => troca.ok, /Esta operação foi concluída/);
    assert.deepEqual(a.cli.resultadosDaTelaMantida(), []);
    b.liberar();
    await emVoo;
});

test('consultas que faltavam não substituem a recusa anterior', async () => {
    const consultas: Array<[string, RequestInit]> = [
        ['/api/admin/clientes/analisar-cadastro', post({ nome: 'x' })],
        ['/api/admin/contratos/c1/financeiro/cronograma/simulacao', post({})],
        ['/api/admin/contratos/c1/financeiro/tratamentos/t1/simulacao', post({})],
        ['/api/admin/inteligencia/importacoes', post({ acao: 'ler' })],
    ];
    for (const [url, init] of consultas) {
        const a: Amb = ambiente({ sessoes: [S1], alvo: { status: 422, corpo: { ok: false } }, diagnostico: TROCA_PROVADA });
        await a.mod.adminFetch('/api/x', post());
        responder({ [url]: async () => respostaJson({ ok: true, data: {} }) });
        await a.mod.adminFetch(url, init);
        await chegarAoFinal(a);
        assert.equal(a.cli.resultadosDaTelaMantida().length, 1, url);
        assert.match(a.cli.resultadosDaTelaMantida()[0], /o servidor recusou/, url);
    }
});

test('conversa que só respondeu: consulta, não apaga nem substitui o resultado anterior', async () => {
    for (const data of [{ tipo: 'resposta' }, { tipo: 'agente' }, { tipo: 'precisa_contexto' }, { tipo: 'navegacao' }]) {
        const a = ambiente({ sessoes: [S1], alvo: { status: 422, corpo: { ok: false } }, diagnostico: TROCA_PROVADA });
        await a.mod.adminFetch('/api/x', post());
        responder({ [CONVERSA]: async () => respostaJson({ ok: true, data }) });
        const r = await a.mod.adminFetch(CONVERSA, post({ texto: 'oi' }));
        await chegarAoFinal(a);
        assert.match(a.cli.resultadosDaTelaMantida()[0], /o servidor recusou/, data.tipo);
        assert.equal(a.cli.resultadosDaTelaMantida().length, 1);
        assert.throws(() => r.status, /antes de concluir esta consulta/);
        assert.equal(a.cli.resultadosDaTelaMantida().length, 1);
    }
});

test('conversa que só respondeu não tira a escrita em voo do último lugar', async () => {
    const a = ambiente({ sessoes: [S1], diagnostico: TROCA_PROVADA });
    const r = await a.mod.adminFetch('/api/x', post());
    responder({ [CONVERSA]: async () => respostaJson({ ok: true, data: { tipo: 'resposta' } }) });
    await a.mod.adminFetch(CONVERSA, post({ texto: 'oi' }));
    await chegarAoFinal(a);
    assert.match((await erroDe(r.json())).message, ULTIMA);
});

test('conversa que alterou rascunho é resultado de escrita', async () => {
    for (const data of [{ tipo: 'rascunho' }, { tipo: 'preview' }, { tipo: 'resultado_acao' }, { tipo: 'nao_suportado' }, { tipo: 'navegacao', proposta: {} }]) {
        const a = ambiente({ sessoes: [S1], alvo: { status: 422, corpo: { ok: false } }, diagnostico: TROCA_PROVADA });
        await a.mod.adminFetch('/api/x', post());
        responder({ [CONVERSA]: async () => respostaJson({ ok: true, data }) });
        await a.mod.adminFetch(CONVERSA, post({ texto: 'cancele' }));
        await chegarAoFinal(a);
        assert.equal(a.cli.resultadosDaTelaMantida().length, 1, data.tipo);
        assert.match(a.cli.resultadosDaTelaMantida()[0], ULTIMA, data.tipo);
    }
});

test('conversa com falha nunca vira recusa: um rascunho pode ter sido salvo', async () => {
    const casos: Array<[number, unknown]> = [[422, { ok: false }], [500, { ok: false }], [200, { ok: false }]];
    for (const [status, corpo] of casos) {
        const a = ambiente({ sessoes: [S1], diagnostico: TROCA_PROVADA });
        responder({ [CONVERSA]: async () => respostaJson(corpo, status) });
        await a.mod.adminFetch(CONVERSA, post({ texto: 'oi' }));
        await chegarAoFinal(a);
        assert.match(a.cli.resultadosDaTelaMantida()[0], /Resultado incerto/, String(status));
    }
});

test('conversa com falha de rede é resultado incerto', async () => {
    const a = ambiente({ sessoes: [S1], diagnostico: TROCA_PROVADA });
    responder({ [CONVERSA]: async () => { throw new TypeError('fetch failed'); } });
    await erroDe(a.mod.adminFetch(CONVERSA, post({ texto: 'oi' })));
    await chegarAoFinal(a);
    assert.match(a.cli.resultadosDaTelaMantida()[0], /Resultado incerto/);
});

test('conversa que começou antes de outra escrita não vira a última ao responder', async () => {
    const a = ambiente({ sessoes: [S1], diagnostico: TROCA_PROVADA });
    const c = emEspera();
    responder({ [CONVERSA]: async () => { await c.espera; return respostaJson({ ok: true, data: { tipo: 'rascunho' } }); } });
    const emVoo = a.mod.adminFetch(CONVERSA, post({ texto: 'oi' }));
    await proximoCiclo();
    responder({ '/api/b': async () => respostaJson({ ok: false }, 422) });
    await a.mod.adminFetch('/api/b', post());
    c.liberar();
    const r = await emVoo;
    await chegarAoFinal(a);
    assert.equal(a.cli.resultadosDaTelaMantida().length, 1);
    assert.match(a.cli.resultadosDaTelaMantida()[0], /o servidor recusou/);
    assert.throws(() => r.ok, /Esta operação foi concluída/);
});

test('resposta com JSON ilegível e aba final: resultado incerto, não concluída', async () => {
    const a = ambiente({ sessoes: [S1], diagnostico: TROCA_PROVADA });
    responder({ '/api/z': async () => new Response('<html>', { headers: JSON_H }) });
    await a.mod.adminFetch('/api/z', post());
    await chegarAoFinal(a);
    assert.match(a.cli.resultadosDaTelaMantida()[0], /Resultado incerto/);
});

test('só JSON fechado é lido na chegada: json-seq, +json e parâmetros', async () => {
    const casos: Array<[string, number]> = [['application/json', 1], ['application/json; charset=utf-8', 1], ['application/problem+json', 1], ['application/json-seq', 0], ['text/event-stream', 0], ['application/x-ndjson', 0]];
    for (const [tipo, esperado] of casos) {
        const a = ambiente({ sessoes: [S1], diagnostico: [NAO_ARMAR] });
        let clones = 0;
        responder({ '/api/s': async () => { const r = new Response('{}', { headers: { 'content-type': tipo } }); const clonar = r.clone.bind(r); r.clone = () => { clones += 1; return clonar(); }; return r; } });
        await a.mod.adminFetch('/api/s', post());
        assert.equal(clones, esperado, tipo);
    }
});

test('inconclusivo: o resultado continua anotado para quando a aba chegar ao final', async () => {
    const a = ambiente({ sessoes: [S1, 'http500'], diagnostico: [consulta('ATIVA', true), 'rede', consulta('ATIVA', false)] });
    await a.armar();
    const agora = Date.now;
    const inicio = agora();
    Date.now = () => inicio + 31000;
    try {
        const e = await erroDe(a.mod.adminFetch('/api/x', post()));
        assert.equal(e.tipo, 'ENDERECO_EM_VERIFICACAO');
        a.cli.sessaoValida();
        assert.deepEqual(a.cli.resultadosDaTelaMantida(), []);
        Date.now = () => inicio + 62000;
        await chegarAoFinal(a);
        assert.equal(a.cli.resultadosDaTelaMantida().length, 1);
        assert.match(a.cli.resultadosDaTelaMantida()[0], ULTIMA);
    }
    finally { Date.now = agora; }
});

// ---------------------------------------------------------------- r7: o descarte usa a mesma classificação
const DESCARTES: Array<[string, Sessao[]]> = [['confirmação falhou', [S1, 'http500']], ['outra sessão', [S1, OUTRA]], ['sessão encerrada', [S1, ENCERRADA]]];
const descarte = async (sessoes: Sessao[], url: string, init: RequestInit, responde: () => Promise<Response>) => {
    const a = ambiente({ sessoes, diagnostico: [NAO_ARMAR] });
    responder({ [url]: responde });
    const e = await erroDe(a.mod.adminFetch(url, init));
    return { a, e };
};
/** Aviso de escrita tem prioridade: outro de escrita soma; o de descarte é substituído. */
const temPrioridadeDeEscrita = (a: Amb) => {
    (a.ctx as unknown as { guardarAvisoDeContexto: (texto: string, origem: string) => void }).guardarAvisoDeContexto('Outro aviso.', 'escrita');
    return a.aviso() !== 'Outro aviso.';
};

test('descarte: 200 com ok:false continua recusa, nunca concluída', async () => {
    for (const [nome, sessoes] of DESCARTES) {
        const { a, e } = await descarte(sessoes, '/api/x', post(), async () => respostaJson({ ok: false }));
        assert.match(e.message, /o servidor recusou/, nome);
        assert.doesNotMatch(e.message, /foi concluída (?:antes|, mas)|A operação foi concluída/, nome);
        assert.match(a.aviso()!, /o servidor recusou/, nome);
        assert.equal(temPrioridadeDeEscrita(a), true, nome);
    }
});

test('descarte: JSON ilegível em escrita com sucesso continua incerto', async () => {
    for (const [nome, sessoes] of DESCARTES) {
        const { e } = await descarte(sessoes, '/api/x', post(), async () => new Response('<html>', { headers: JSON_H }));
        assert.match(e.message, /Resultado incerto/, nome);
    }
});

test('descarte: escrita concluída e recusada seguem como antes', async () => {
    for (const [nome, sessoes] of DESCARTES) {
        assert.match((await descarte(sessoes, '/api/x', post(), async () => respostaJson({ ok: true }))).e.message, /A operação foi concluída/, nome);
        assert.match((await descarte(sessoes, '/api/x', post(), async () => respostaJson({ ok: false }, 422))).e.message, /o servidor recusou/, nome);
        assert.match((await descarte(sessoes, '/api/x', post(), async () => respostaJson({ ok: false }, 500))).e.message, /Resultado incerto/, nome);
    }
});

test('descarte: conversa que falhou é incerta, inclusive 4xx e 200 com ok:false', async () => {
    const casos: Array<[number, unknown]> = [[422, { ok: false }], [404, { ok: false }], [200, { ok: false }], [500, { ok: false }]];
    for (const [nome, sessoes] of DESCARTES) {
        for (const [status, corpo] of casos) {
            const { a, e } = await descarte(sessoes, CONVERSA, post({ texto: 'oi' }), async () => respostaJson(corpo, status));
            assert.match(e.message, /Resultado incerto/, nome + status);
            assert.match(a.aviso()!, /Resultado incerto/, nome + status);
            assert.equal(temPrioridadeDeEscrita(a), true, nome + status);
        }
    }
});

test('descarte: conversa que alterou rascunho fala como escrita', async () => {
    for (const [nome, sessoes] of DESCARTES) {
        const { e } = await descarte(sessoes, CONVERSA, post({ texto: 'oi' }), async () => respostaJson({ ok: true, data: { tipo: 'rascunho' } }));
        assert.match(e.message, /A operação foi concluída/, nome);
    }
});

test('descarte: conversa que só leu e POST de consulta não falam como operação nem ganham prioridade', async () => {
    const pedidos: Array<[string, RequestInit, unknown]> = [
        [CONVERSA, post({ texto: 'oi' }), { ok: true, data: { tipo: 'resposta' } }],
        [IMPORTACOES, post({ acao: 'estado' }), { ok: true, data: {} }],
    ];
    for (const [nome, sessoes] of DESCARTES) {
        for (const [url, init, corpo] of pedidos) {
            const { a, e } = await descarte(sessoes, url, init, async () => respostaJson(corpo));
            assert.doesNotMatch(e.message, /operação/, nome + url);
            assert.match(e.message, /descartad/, nome + url);
            assert.match(a.aviso()!, /descartad/, nome + url);
            assert.equal(temPrioridadeDeEscrita(a), false, nome + url);
        }
    }
});

test('conversa recusada pelo contexto antigo mantém a prioridade; consulta não', async () => {
    const recusa = async () => respostaJson({ codigo: 'AUTENTICACAO_ADMINISTRATIVA' }, 409);
    const c = await descarte([S1], CONVERSA, post({ texto: 'oi' }), recusa);
    assert.equal(c.e.tipo, 'RECUSADA_PELO_CONTEXTO');
    assert.equal(temPrioridadeDeEscrita(c.a), true);
    const q = await descarte([S1], IMPORTACOES, post({ acao: 'estado' }), recusa);
    assert.equal(q.e.tipo, 'RECUSADA_PELO_CONTEXTO');
    assert.equal(temPrioridadeDeEscrita(q.a), false);
});

// ---------------------------------------------------------------- r7: conversas concorrentes seguem a ordem de envio
async function duasConversas(ordemDeResposta: [0 | 1, 0 | 1], respostas: [() => Response, () => Response]) {
    const a = ambiente({ sessoes: [S1], diagnostico: TROCA_PROVADA });
    const esperas = [emEspera(), emEspera()];
    let n = 0;
    responder({ [CONVERSA]: async () => { const i = n++; await esperas[i].espera; return respostas[i](); } });
    const pedidos = [a.mod.adminFetch(CONVERSA, post({ texto: '1' })), a.mod.adminFetch(CONVERSA, post({ texto: '2' }))];
    for (let i = 0; i < 20 && n < 2; i += 1) await proximoCiclo();
    assert.equal(n, 2);
    for (const i of ordemDeResposta) {
        esperas[i].liberar();
        await pedidos[i];
    }
    await chegarAoFinal(a);
    return { a, pedidos };
}
const RASCUNHO = () => respostaJson({ ok: true, data: { tipo: 'rascunho' } });
const SO_LEU = () => respostaJson({ ok: true, data: { tipo: 'resposta' } });
const FALHA_500 = () => respostaJson({ ok: false }, 500);

test('conversas: a segunda enviada vence, responda em que ordem responder', async () => {
    for (const ordem of [[0, 1], [1, 0]] as Array<[0 | 1, 0 | 1]>) {
        const { a } = await duasConversas(ordem, [RASCUNHO, FALHA_500]);
        assert.equal(a.cli.resultadosDaTelaMantida().length, 1, String(ordem));
        assert.match(a.cli.resultadosDaTelaMantida()[0], /Resultado incerto/, String(ordem));
    }
    for (const ordem of [[0, 1], [1, 0]] as Array<[0 | 1, 0 | 1]>) {
        const { a } = await duasConversas(ordem, [FALHA_500, RASCUNHO]);
        assert.equal(a.cli.resultadosDaTelaMantida().length, 1, String(ordem));
        assert.match(a.cli.resultadosDaTelaMantida()[0], ULTIMA, String(ordem));
    }
});

test('conversas: a que só leu não tira o lugar da que alterou', async () => {
    for (const ordem of [[0, 1], [1, 0]] as Array<[0 | 1, 0 | 1]>) {
        const { a } = await duasConversas(ordem, [RASCUNHO, SO_LEU]);
        assert.match(a.cli.resultadosDaTelaMantida()[0], ULTIMA, String(ordem));
    }
});

test('conversas: a resposta anterior, lida com a aba final, não fala como a última', async () => {
    const { pedidos } = await duasConversas([0, 1], [RASCUNHO, RASCUNHO]);
    const anterior = await pedidos[0];
    assert.throws(() => anterior.ok, /Esta operação foi concluída/);
    const ultima = await pedidos[1];
    assert.throws(() => ultima.ok, ULTIMA);
});

test('conversa com falha de rede depois de outra escrita não vira a última; a que saiu depois vira', async () => {
    const a = ambiente({ sessoes: [S1], diagnostico: TROCA_PROVADA });
    const c = emEspera();
    responder({ [CONVERSA]: async () => { await c.espera; throw new TypeError('fetch failed'); } });
    const emVoo = erroDe(a.mod.adminFetch(CONVERSA, post({ texto: 'oi' })));
    for (let i = 0; i < 10; i += 1) await proximoCiclo();
    responder({ '/api/b': async () => respostaJson({ ok: false }, 422) });
    await a.mod.adminFetch('/api/b', post());
    c.liberar();
    await emVoo;
    await chegarAoFinal(a);
    assert.match(a.cli.resultadosDaTelaMantida()[0], /o servidor recusou/);
});

test('renovação com falha de rede fica fora da ordem: só registra com a aba já final', async () => {
    const a = ambiente({ sessoes: [S1], diagnostico: TROCA_PROVADA });
    responder({ '/api/admin/perfil/senha': async () => { throw new TypeError('fetch failed'); } });
    await erroDe(a.mod.adminFetch('/api/admin/perfil/senha', post()));
    await chegarAoFinal(a);
    assert.deepEqual(a.cli.resultadosDaTelaMantida(), []);
});
