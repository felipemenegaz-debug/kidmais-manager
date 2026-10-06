import assert from 'node:assert/strict';
import test from 'node:test';
import { carregarModulo } from '../../lib/acessos/teste-carregador.ts';

/**
 * Saída da sessão com rede controlada (código real de components/admin/sair.ts; só o fetch, a navegação e o aviso
 * são injetados). Cada cenário observa o que foi pedido ao servidor, o resultado devolvido, o aviso deixado para a
 * tela de login e a navegação — nunca a presença de strings no código.
 */
type Mod = {
    sairDaSessao: (deps: Record<string, unknown>) => Promise<{ confirmada: boolean; motivo: string; pedidos: number }>;
    lembrarCsrf: (csrf: unknown) => void;
    reiniciarSaidaParaTestes: () => void;
    AVISO_SAIDA_NAO_CONFIRMADA: string;
    AVISO_SAIDA_PRAZO: string;
};
type Contexto = {
    saidaDaSessaoEmAndamento: () => boolean;
    guardarAvisoDeContexto: (texto: string) => void;
    reiniciarContextoEmpresa: (aviso?: string, destino?: string) => void;
    lerAvisoDeContexto: () => string | null;
};
type Resposta = { status: number; corpo?: unknown } | 'rede' | 'pendente' | { atrasoMs: number; status: number; corpo?: unknown };
type Roteiro = { get?: Resposta[]; post?: Resposta[] };

const CSRF_A = 'A'.repeat(43);
const CSRF_B = 'B'.repeat(43);
const sessaoAberta = { status: 200, corpo: { ok: true, data: { usuarioId: 'u1', sessaoId: 's1', csrf: CSRF_B } } };
const sessaoEncerrada = { status: 200, corpo: { ok: true, data: { usuarioId: null, csrf: 'x' } } };
const logoutOk = { status: 200, corpo: { ok: true } };

function ambiente(roteiro: Roteiro) {
    const g = globalThis as unknown as Record<string, unknown>;
    const navegacoesGlobais: string[] = [];
    const armazenado = new Map<string, string>();
    g.window = { location: { pathname: '/admin/dashboard', assign: (u: string) => navegacoesGlobais.push(`assign:${u}`), replace: (u: string) => navegacoesGlobais.push(`replace:${u}`) } };
    g.sessionStorage = { getItem: (k: string) => armazenado.get(k) ?? null, setItem: (k: string, v: string) => armazenado.set(k, v), removeItem: (k: string) => armazenado.delete(k) };
    const cache = new Map<string, Record<string, unknown>>();
    const mod = carregarModulo('components/admin/sair.ts', {}, cache) as unknown as Mod;
    const contexto = carregarModulo('lib/http/contexto-empresa-cliente.ts', {}, cache) as unknown as Contexto;
    mod.reiniciarSaidaParaTestes();
    const chamadas: Array<{ metodo: string; csrf: string | null; sessao: string | null; abortado: () => boolean }> = [];
    const navegacoes: string[] = [];
    const avisos: string[] = [];
    const contadores = { GET: 0, POST: 0 };
    const pendentes: Array<() => void> = [];
    const fetchFalso = (_url: string, init: RequestInit = {}) => {
        const metodo = (init.method ?? 'GET').toUpperCase() as 'GET' | 'POST';
        const cabecalhos = new Headers(init.headers);
        const sinal = init.signal as AbortSignal | undefined;
        chamadas.push({ metodo, csrf: cabecalhos.get('x-csrf-token'), sessao: cabecalhos.get('x-kidmais-sessao'), abortado: () => Boolean(sinal?.aborted) });
        const lista = roteiro[metodo.toLowerCase() as 'get' | 'post'] ?? [];
        const resposta = lista[Math.min(contadores[metodo], lista.length - 1)];
        contadores[metodo] += 1;
        if (resposta === undefined)
            throw new Error(`roteiro sem resposta para ${metodo}`);
        if (resposta === 'rede')
            return Promise.reject(new TypeError('fetch failed'));
        if (resposta === 'pendente')
            return new Promise<Response>((resolve) => { pendentes.push(() => resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }))); });
        if ('atrasoMs' in resposta)
            return new Promise<Response>((resolve) => setTimeout(() => resolve(new Response(JSON.stringify(resposta.corpo ?? null), { status: resposta.status })), resposta.atrasoMs));
        return Promise.resolve(new Response(JSON.stringify(resposta.corpo ?? null), { status: resposta.status }));
    };
    const deps = { fetch: fetchFalso as unknown as typeof fetch, navegar: (destino: string) => navegacoes.push(destino), avisar: (texto: string) => avisos.push(texto) };
    return { mod, contexto, deps, chamadas, navegacoes, avisos, pendentes, navegacoesGlobais, armazenado, posts: () => chamadas.filter((c) => c.metodo === 'POST'), gets: () => chamadas.filter((c) => c.metodo === 'GET') };
}

test('respostas tardias depois do clique em sair não mudam nada: 401/contexto mudado não navegam nem deixam aviso por cima da saída', async () => {
    const a = ambiente({ post: ['pendente'] });
    a.mod.lembrarCsrf(CSRF_A);
    assert.equal(a.contexto.saidaDaSessaoEmAndamento(), false);
    const saida = a.mod.sairDaSessao(a.deps);
    assert.equal(a.contexto.saidaDaSessaoEmAndamento(), true, 'marcada desde o clique, antes da resposta do servidor');
    // Uma operação de negócio em voo termina agora com "sessão encerrada"/"contexto mudou" (caminhos de admin-fetch).
    a.contexto.reiniciarContextoEmpresa('A empresa ativa ou a sessão mudou. Os dados da tela anterior foram descartados.', '/admin/login');
    a.contexto.reiniciarContextoEmpresa('Resultado incerto.');
    assert.deepEqual(a.navegacoesGlobais, [], 'nenhuma navegação tardia');
    assert.equal(a.contexto.lerAvisoDeContexto(), null, 'nenhum aviso tardio');
    a.pendentes.forEach((liberar) => liberar());
    const r = await saida;
    assert.deepEqual([r.motivo, a.navegacoes, a.avisos], ['CONFIRMADA', ['/admin/login'], []]);
    // Depois da saída confirmada a regra continua: nada sobrepõe o resultado.
    a.contexto.reiniciarContextoEmpresa('Sua sessão terminou antes do envio. Nada foi enviado.', '/admin/login');
    assert.deepEqual([a.navegacoesGlobais, a.contexto.lerAvisoDeContexto()], [[], null]);
});

test('sem saída em andamento, o reinício de contexto continua navegando e avisando (a regra só vale durante a saída)', () => {
    const a = ambiente({});
    a.contexto.reiniciarContextoEmpresa('Aviso de contexto.', '/admin/login');
    assert.deepEqual(a.navegacoesGlobais, ['replace:/admin/login']);
    assert.equal(a.contexto.lerAvisoDeContexto(), 'Aviso de contexto.');
});

test('saída confirmada com o CSRF lembrado pela tela: um único POST, sem leitura prévia, sem cabeçalho de contexto, sem aviso', async () => {
    const a = ambiente({ post: [logoutOk] });
    a.mod.lembrarCsrf(CSRF_A);
    const r = await a.mod.sairDaSessao(a.deps);
    assert.deepEqual(r, { confirmada: true, motivo: 'CONFIRMADA', pedidos: 1 });
    assert.equal(a.gets().length, 0, 'não depende da confirmação prévia de contexto');
    assert.deepEqual(a.posts().map((p) => [p.csrf, p.sessao]), [[CSRF_A, null]]);
    assert.deepEqual(a.navegacoes, ['/admin/login']);
    assert.deepEqual(a.avisos, []);
});

test('sem CSRF lembrado: lê a sessão uma vez e envia o POST com o CSRF atual', async () => {
    const a = ambiente({ get: [sessaoAberta], post: [logoutOk] });
    const r = await a.mod.sairDaSessao(a.deps);
    assert.deepEqual([r.motivo, r.pedidos], ['CONFIRMADA', 2]);
    assert.equal(a.posts()[0].csrf, CSRF_B);
    assert.deepEqual(a.avisos, []);
});

test('leitura prévia com 503 ou falha de rede sem CSRF lembrado: nenhum POST, aviso de não confirmado e ida ao login', async () => {
    for (const leitura of [{ status: 503, corpo: { ok: false } }, 'rede' as const]) {
        const a = ambiente({ get: [leitura], post: [logoutOk] });
        const r = await a.mod.sairDaSessao(a.deps);
        assert.deepEqual([r.confirmada, r.motivo], [false, 'NAO_CONFIRMADA']);
        assert.equal(a.posts().length, 0);
        assert.deepEqual(a.avisos, [a.mod.AVISO_SAIDA_NAO_CONFIRMADA]);
        assert.deepEqual(a.navegacoes, ['/admin/login']);
    }
});

test('leitura prévia com 503 MAS CSRF lembrado: o POST é enviado mesmo assim e a sessão é encerrada', async () => {
    const a = ambiente({ get: [{ status: 503, corpo: { ok: false } }], post: [logoutOk] });
    a.mod.lembrarCsrf(CSRF_A);
    const r = await a.mod.sairDaSessao(a.deps);
    assert.deepEqual([r.motivo, a.gets().length, a.posts().length], ['CONFIRMADA', 0, 1]);
});

test('requisição que nunca responde: prazo esgotado, pedido abortado, aviso explícito e navegação dentro do prazo', async () => {
    const a = ambiente({ post: ['pendente'] });
    a.mod.lembrarCsrf(CSRF_A);
    const inicio = Date.now();
    const r = await a.mod.sairDaSessao({ ...a.deps, prazoMs: 60 });
    const decorrido = Date.now() - inicio;
    assert.deepEqual([r.confirmada, r.motivo, r.pedidos], [false, 'PRAZO_ESGOTADO', 1]);
    assert.ok(decorrido >= 55 && decorrido < 1000, `decorrido ${decorrido}ms`);
    assert.equal(a.posts()[0].abortado(), true, 'o pedido pendente é abortado');
    assert.deepEqual(a.avisos, [a.mod.AVISO_SAIDA_PRAZO]);
    assert.deepEqual(a.navegacoes, ['/admin/login']);
    // Resposta tardia (o servidor acorda depois do prazo): nada muda — nem aviso novo, nem segunda navegação.
    a.pendentes.forEach((liberar) => liberar());
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(a.avisos, [a.mod.AVISO_SAIDA_PRAZO]);
    assert.deepEqual(a.navegacoes, ['/admin/login']);
});

test('resposta que chega depois do prazo é ignorada: resultado e aviso continuam "prazo esgotado"', async () => {
    const a = ambiente({ post: [{ atrasoMs: 120, status: 200, corpo: { ok: true } }] });
    a.mod.lembrarCsrf(CSRF_A);
    const r = await a.mod.sairDaSessao({ ...a.deps, prazoMs: 40 });
    assert.equal(r.motivo, 'PRAZO_ESGOTADO');
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.deepEqual(a.avisos, [a.mod.AVISO_SAIDA_PRAZO]);
    assert.deepEqual(a.navegacoes, ['/admin/login']);
});

test('POST recusado (500) ou com falha de rede: não confirmado, aviso explícito, sem repetição automática', async () => {
    for (const post of [{ status: 500, corpo: { ok: false, erro: 'Falha na autenticação.' } }, 'rede' as const]) {
        const a = ambiente({ post: [post] });
        a.mod.lembrarCsrf(CSRF_A);
        const r = await a.mod.sairDaSessao(a.deps);
        assert.deepEqual([r.confirmada, r.motivo, r.pedidos], [false, 'NAO_CONFIRMADA', 1]);
        assert.deepEqual(a.avisos, [a.mod.AVISO_SAIDA_NAO_CONFIRMADA]);
        assert.deepEqual(a.navegacoes, ['/admin/login']);
    }
});

test('CSRF lembrado recusado (403, rotação após reautenticação): uma leitura e um único POST a mais; recusa repetida não insiste', async () => {
    const renovado = ambiente({ get: [sessaoAberta], post: [{ status: 403, corpo: { ok: false, erro: 'Verificação CSRF recusada.' } }, logoutOk] });
    renovado.mod.lembrarCsrf(CSRF_A);
    const r = await renovado.mod.sairDaSessao(renovado.deps);
    assert.deepEqual([r.motivo, r.pedidos], ['CONFIRMADA', 3]);
    assert.deepEqual(renovado.posts().map((p) => p.csrf), [CSRF_A, CSRF_B]);
    const insistente = ambiente({ get: [sessaoAberta], post: [{ status: 403, corpo: { ok: false } }, { status: 403, corpo: { ok: false } }, logoutOk] });
    insistente.mod.lembrarCsrf(CSRF_A);
    const r2 = await insistente.mod.sairDaSessao(insistente.deps);
    assert.deepEqual([r2.motivo, r2.pedidos, insistente.posts().length], ['NAO_CONFIRMADA', 3, 2]);
    assert.deepEqual(insistente.avisos, [insistente.mod.AVISO_SAIDA_NAO_CONFIRMADA]);
});

test('sessão já encerrada: POST com 401, ou leitura sem usuário, leva ao login sem aviso falso de "não confirmado"', async () => {
    const pelo401 = ambiente({ post: [{ status: 401, corpo: { ok: false, erro: 'Autenticação administrativa necessária.' } }] });
    pelo401.mod.lembrarCsrf(CSRF_A);
    const r1 = await pelo401.mod.sairDaSessao(pelo401.deps);
    assert.deepEqual([r1.confirmada, r1.motivo], [false, 'SESSAO_JA_ENCERRADA']);
    assert.deepEqual([pelo401.avisos, pelo401.navegacoes], [[], ['/admin/login']]);
    const pelaLeitura = ambiente({ get: [sessaoEncerrada], post: [logoutOk] });
    const r2 = await pelaLeitura.mod.sairDaSessao(pelaLeitura.deps);
    assert.deepEqual([r2.motivo, pelaLeitura.posts().length, pelaLeitura.avisos], ['SESSAO_JA_ENCERRADA', 0, []]);
});

test('clique repetido durante a saída: a mesma saída é compartilhada e só um POST é enviado; depois do resultado, um novo clique é uma nova saída', async () => {
    const a = ambiente({ post: ['pendente', logoutOk] });
    a.mod.lembrarCsrf(CSRF_A);
    const primeira = a.mod.sairDaSessao(a.deps);
    const segunda = a.mod.sairDaSessao(a.deps);
    assert.equal(primeira, segunda, 'mesma promessa');
    assert.equal(a.posts().length, 1);
    a.pendentes.forEach((liberar) => liberar());
    assert.deepEqual([(await primeira).motivo, (await segunda).motivo], ['CONFIRMADA', 'CONFIRMADA']);
    assert.deepEqual(a.navegacoes, ['/admin/login']);
    a.mod.lembrarCsrf(CSRF_A);
    await a.mod.sairDaSessao(a.deps);
    assert.equal(a.posts().length, 2, 'nova saída explícita depois do resultado');
});

test('prazo total: leitura que consome o prazo deixa o POST sem tempo; nada é enviado "no escuro"', async () => {
    const a = ambiente({ get: [{ atrasoMs: 80, status: 200, corpo: sessaoAberta.corpo }], post: [logoutOk] });
    const r = await a.mod.sairDaSessao({ ...a.deps, prazoMs: 40 });
    assert.deepEqual([r.motivo, a.posts().length], ['PRAZO_ESGOTADO', 0]);
    assert.deepEqual(a.avisos, [a.mod.AVISO_SAIDA_PRAZO]);
});
