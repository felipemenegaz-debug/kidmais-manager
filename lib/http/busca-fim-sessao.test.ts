import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { carregarModulo } from '../acessos/teste-carregador.ts';

/**
 * Busca guardada na aba × confirmações da sessão em adminFetch (rodada 11, parecer do Astra sobre a r10). Módulos reais,
 * só o HTTP simulado:
 *   - 401 da geração vigente na confirmação PRÉVIA (pedido iniciado pela lista, sem depender do foco nem do ciclo do painel)
 *     é fim da sessão: trava e apaga a busca antes de navegar ao login. O mesmo na prévia da troca de empresa e na
 *     reautenticação;
 *   - confirmação POSTERIOR obsoleta (saiu antes de uma troca desta página) que chega depois de a troca terminar recusada:
 *     não decide nada; a sessão vigente é confirmada de novo antes de descartar, ir ao login ou travar a busca.
 * Rodada 12 (parecer do Astra sobre a r11):
 *   - o fim vigente trava a busca mesmo quando a aba chega ao estado final da troca de host durante a confirmação
 *     (lista, troca de empresa, reautenticação e 401 do POST da troca), sem navegar;
 *   - a pós-confirmação antiga que chega com a troca ainda pendente espera o resultado da troca: recusada, a lista é
 *     entregue e a busca continua; concluída, o descarte de hoje; sem resultado no prazo, nada é entregue nem decidido.
 */
type Fn = (...a: unknown[]) => unknown;
type Leitura = { sessao: string; empresa: string } | 'sem-usuario' | 401;
const S1: Leitura = { sessao: 's1', empresa: 'A' }, S2: Leitura = { sessao: 's2', empresa: 'B' };
const CHAVE = 'kidmais-busca:contratos';

function ambiente(leituras: Array<Leitura | (() => Promise<Leitura>)>, troca: { status: number; segurar?: Promise<void> } = { status: 200 }) {
    const armazenado = new Map<string, string>(), navegacoes: string[] = [], pedidos: string[] = [];
    const g = globalThis as unknown as Record<string, unknown>;
    g.window = { addEventListener() {}, removeEventListener() {}, location: { pathname: '/admin/contratos', search: '?filtro=proximas', host: 'kidmais.test', hostname: 'kidmais.test', origin: 'https://kidmais.test', href: 'https://kidmais.test/admin/contratos?filtro=proximas', replace: (u: string) => navegacoes.push(`replace:${u}`), assign: (u: string) => navegacoes.push(`assign:${u}`) } };
    g.sessionStorage = {
        getItem: (k: string) => armazenado.get(k) ?? null, setItem: (k: string, v: string) => { armazenado.set(k, String(v)); },
        removeItem: (k: string) => { armazenado.delete(k); }, key: (i: number) => [...armazenado.keys()][i] ?? null, get length() { return armazenado.size; },
    };
    let n = 0;
    const resposta = (l: Leitura) => l === 401 ? new Response('{"ok":false}', { status: 401 })
        : Response.json({ ok: true, data: l === 'sem-usuario' ? { usuarioId: null, csrf: 'c' } : { usuarioId: 'u', sessaoId: l.sessao, csrf: 'c', contexto: { empresaAtual: { id: l.empresa } } } });
    g.fetch = async (input: string, init: RequestInit = {}) => {
        const metodo = (init.method ?? 'GET').toUpperCase();
        pedidos.push(`${metodo} ${String(input)}`);
        if (String(input) === '/api/admin/autenticacao' && metodo === 'GET') {
            const passo = leituras[Math.min(n, leituras.length - 1)]; n += 1;
            return resposta(typeof passo === 'function' ? await passo() : passo);
        }
        if (String(input) === '/api/endereco-atual') return Response.json({ modoEfetivo: 'ATIVA', painelNesteHost: false, toleranciaAtiva: true });
        if (String(input) === '/api/admin/autenticacao') await troca.segurar;
        if (String(input) === '/api/admin/autenticacao') return new Response(JSON.stringify({ ok: troca.status < 400 }), { status: troca.status, headers: { 'content-type': 'application/json' } });
        return Response.json({ ok: true, data: { itens: [] } });
    };
    const cache = new Map<string, Record<string, unknown>>();
    const ctx = carregarModulo('lib/http/contexto-empresa-cliente.ts', {}, cache) as Record<string, Fn>;
    const aba = carregarModulo('lib/http/busca-na-aba.ts', {}, cache) as Record<string, Fn>;
    const mod = carregarModulo('lib/http/admin-fetch.ts', {}, cache) as Record<string, Fn>;
    const cli = carregarModulo('lib/enderecos/cliente.ts', {}, cache) as Record<string, Fn>;
    ctx.registrarContextoEmpresa('s1', 'A');
    aba.guardarBuscaNaAba('contratos', 'Helena');
    assert.equal(aba.lerBuscaDaAba('contratos'), 'Helena', 'premissa: busca guardada');
    /** A aba chega ao estado final da troca de host (a consulta real do módulo de endereço prova a troca). */
    const chegarAoFinal = async () => {
        assert.equal(await cli.decidirFalhaSessao({ tipo: '403', telaCarregada: true, aindaValida: () => true }), 'ENDERECO_MUDOU');
        assert.equal(cli.enderecoFinal(), true, 'premissa: estado final');
    };
    return { ctx, aba, mod, cli, armazenado, navegacoes, pedidos, chegarAoFinal, leiturasFeitas: () => n, posts: () => pedidos.filter((p) => p.startsWith('POST')).length };
}
async function erroDe(p: unknown) {
    try { await p; return null; } catch (e) { return e as Error & { tipo?: string }; }
}
const LISTA = '/api/admin/contratos/lista?filtro=proximas';
const travada = (a: ReturnType<typeof ambiente>) => {
    assert.equal(a.armazenado.has(CHAVE), false, 'a busca saiu da aba');
    a.aba.guardarBuscaNaAba('contratos', 'Theo');
    assert.equal(a.armazenado.has(CHAVE), false, 'e não pode ser gravada de novo');
};

for (const [rotulo, fim] of [['401', 401], ['200 sem usuário (controle)', 'sem-usuario']] as const) {
    test(`prévia da lista com ${rotulo}: trava e apaga a busca e vai ao login, sem esperar o ciclo do painel`, async () => {
        const a = ambiente([fim]);
        const e = await erroDe(a.mod.adminFetch(LISTA));
        assert.equal(e?.tipo, 'SESSAO_ENCERRADA');
        assert.equal(a.navegacoes.length, 1); assert.match(a.navegacoes[0], /^assign:\/admin\/login/);
        assert.equal(a.pedidos.some((p) => p.includes('/lista')), false, 'nada é pedido à lista');
        travada(a);
    });
}

test('401 obsoleto na prévia (troca desta página em curso): não é fim da sessão nem trava a busca', async () => {
    const a = ambiente([401]);
    a.ctx.iniciarTrocaDeEmpresa();
    try {
        const e = await erroDe(a.mod.adminFetch(LISTA));
        assert.equal(e?.tipo, 'SESSAO_NAO_CONFIRMADA');
        assert.deepEqual(a.navegacoes, []);
        assert.equal(a.aba.lerBuscaDaAba('contratos'), 'Helena');
    } finally { a.ctx.encerrarTrocaDeEmpresa(); }
});

test('prévia da troca de empresa com 401: trava e apaga a busca e vai ao login', async () => {
    const a = ambiente([401]);
    const e = await erroDe(a.mod.trocarEmpresaAtiva('B'));
    assert.match(String(e?.message), /Faça login/);
    assert.equal(a.navegacoes.length, 1); assert.match(a.navegacoes[0], /^assign:\/admin\/login/);
    assert.equal(a.pedidos.filter((p) => p.startsWith('POST')).length, 0, 'nada é enviado');
    travada(a);
});

test('reautenticação com a sessão já encerrada (401 ou sem usuário): a busca sai da aba', async () => {
    for (const fim of [401, 'sem-usuario'] as const) {
        const a = ambiente([fim]);
        const r = await a.mod.reautenticarSessao('senha') as { ok: boolean; erro?: string };
        assert.equal(r.ok, false); assert.match(String(r.erro), /sessão terminou/);
        travada(a);
    }
});

/** Pós-confirmação retida: a leitura da lista sai, a confirmação posterior fica presa até `soltar`. */
function retida() {
    let soltar!: (l: Leitura) => void, avisarPedido!: () => void;
    const pedida = new Promise<void>((r) => { avisarPedido = r; });
    const passo = () => { avisarPedido(); return new Promise<Leitura>((r) => { soltar = r; }); };
    return { passo, pedida, soltar: (l: Leitura) => soltar(l) };
}

for (const [rotulo, antiga] of [['sem usuário', 'sem-usuario'], ['401', 401]] as const) {
    test(`pós-confirmação obsoleta (${rotulo}) depois de troca recusada: revalida a sessão vigente e mantém a busca`, async () => {
        const r = retida();
        const a = ambiente([S1, r.passo, S1], { status: 403 });
        const pedido = a.mod.adminFetch(LISTA) as Promise<Response>;
        await r.pedida;
        // Troca iniciada e recusada pelo servidor enquanto a confirmação posterior estava retida.
        const e = await erroDe((a.mod.trocarEmpresaAtiva('B') as Promise<Response>).then((res) => res.json()));
        assert.equal(e, null, 'a recusa chega como resposta, sem navegar');
        r.soltar(antiga);
        const res = await pedido;
        assert.equal(res.ok, true, 'a lista é entregue');
        assert.deepEqual(a.navegacoes, [], 'sem login nem descarte');
        assert.equal(a.aba.lerBuscaDaAba('contratos'), 'Helena', 'a busca continua');
        a.aba.guardarBuscaNaAba('contratos', 'Theo');
        assert.equal(a.aba.lerBuscaDaAba('contratos'), 'Theo', 'e continua gravável');
    });
}

test('pós-confirmação obsoleta depois de troca concluída: a revalidação vê a sessão nova e descarta, travando a busca', async () => {
    const r = retida();
    const a = ambiente([S1, r.passo, S2], { status: 200 });
    const pedido = a.mod.adminFetch(LISTA);
    await r.pedida;
    a.ctx.iniciarTrocaDeEmpresa(); a.ctx.encerrarTrocaDeEmpresa();
    r.soltar('sem-usuario');
    const e = await erroDe(pedido);
    assert.equal(e?.tipo, 'CONTEXTO_MUDOU');
    assert.deepEqual(a.navegacoes, ['replace:/admin/dashboard']);
    travada(a);
});

// ---------------------------------------------------------------- rodada 12 (parecer do Astra sobre a r11)

const tique = () => new Promise((r) => setImmediate(r));
const ESCRITA = '/api/admin/contratos/r12-escrita';

for (const [rotulo, fim] of [['401', 401], ['200 sem usuário (controle)', 'sem-usuario']] as const) {
    test(`estado final durante a prévia da lista com ${rotulo} vigente: a busca sai e trava, sem navegar`, async () => {
        const r = retida();
        const a = ambiente([r.passo]);
        const pedido = erroDe(a.mod.adminFetch(LISTA));
        await r.pedida;
        await a.chegarAoFinal();
        r.soltar(fim);
        const e = await pedido;
        assert.equal(e?.tipo, 'ENDERECO_EM_VERIFICACAO', 'o estado final continua decidindo o erro');
        assert.deepEqual(a.navegacoes, [], 'tela preservada');
        assert.equal(a.pedidos.some((p) => p.includes('/lista')), false, 'nada é pedido à lista');
        travada(a);
    });

    test(`estado final durante a prévia da troca de empresa com ${rotulo} vigente: a busca sai e trava, nada enviado, sem navegar`, async () => {
        const r = retida();
        const a = ambiente([r.passo]);
        const troca = erroDe(a.mod.trocarEmpresaAtiva('B'));
        await r.pedida;
        await a.chegarAoFinal();
        r.soltar(fim);
        assert.match(String((await troca)?.message), /mudou de endereço/);
        assert.equal(a.posts(), 0, 'nada é enviado');
        assert.deepEqual(a.navegacoes, []);
        travada(a);
    });

    test(`estado final durante a confirmação da reautenticação com ${rotulo} vigente: a busca sai e trava`, async () => {
        const r = retida();
        const a = ambiente([r.passo]);
        const reaut = a.mod.reautenticarSessao('senha') as Promise<{ ok: boolean; erro?: string }>;
        await r.pedida;
        await a.chegarAoFinal();
        r.soltar(fim);
        const res = await reaut;
        assert.equal(res.ok, false); assert.match(String(res.erro), /mudou de endereço/);
        assert.equal(a.posts(), 0, 'a senha não é enviada');
        assert.deepEqual(a.navegacoes, []);
        travada(a);
    });
}

test('estado final durante a prévia com 401 OBSOLETO (troca desta página em curso): a busca não é travada', async () => {
    const r = retida();
    const a = ambiente([r.passo]);
    const pedido = erroDe(a.mod.adminFetch(LISTA));
    await r.pedida;
    a.ctx.iniciarTrocaDeEmpresa();
    try {
        await a.chegarAoFinal();
        r.soltar(401);
        assert.equal((await pedido)?.tipo, 'ENDERECO_EM_VERIFICACAO');
        assert.equal(a.aba.lerBuscaDaAba('contratos'), 'Helena', 'resposta da sessão anterior não fala pela vigente');
    } finally { a.ctx.encerrarTrocaDeEmpresa(); }
});

test('401 no POST da troca com a aba chegando ao estado final enquanto o POST estava retido: a busca sai e trava, sem navegar', async () => {
    let liberar!: () => void;
    const segurar = new Promise<void>((r) => { liberar = r; });
    const a = ambiente([S1], { status: 401, segurar });
    const troca = erroDe(a.mod.trocarEmpresaAtiva('B'));
    while (a.posts() < 1) await tique();
    await a.chegarAoFinal();
    liberar();
    const e = await troca;
    assert.equal(e?.tipo, 'ENDERECO_EM_VERIFICACAO', 'resultado real da troca, sem login');
    assert.deepEqual(a.navegacoes, []);
    travada(a);
});

/** POST da troca retido até `liberar`. */
function postRetido() {
    let liberar!: () => void;
    const segurar = new Promise<void>((r) => { liberar = r; });
    return { segurar, liberar: () => liberar() };
}

/**
 * Ordem do parecer da r11: o pedido da lista sai, a pós-confirmação fica retida, a troca confirma S1/A e envia o POST, o POST
 * fica retido, a resposta antiga chega, e só então o POST é respondido.
 */
async function respostaAntigaComTrocaPendente(antiga: Leitura, depoisDaTroca: Leitura, status: number) {
    const r = retida(), p = postRetido();
    const a = ambiente([S1, r.passo, S1, depoisDaTroca], { status, segurar: p.segurar });
    let resolvido = false;
    const pedido = erroDe((a.mod.adminFetch(LISTA) as Promise<Response>).then((res) => { resolvido = true; return res.json(); }));
    await r.pedida;
    const troca = erroDe((a.mod.trocarEmpresaAtiva('B') as Promise<Response>).then((res) => res.json()));
    while (a.posts() < 1) await tique();
    r.soltar(antiga);
    for (let i = 0; i < 30; i++) await tique();
    assert.equal(resolvido, false, 'nada é entregue antes do resultado da troca');
    assert.deepEqual(a.navegacoes, [], 'nem descarte nem login antes do resultado da troca');
    assert.equal(a.armazenado.has(CHAVE), true, 'a busca não é apagada antes do resultado da troca');
    assert.equal(a.leiturasFeitas(), 3, 'nenhuma releitura com a troca pendente');
    p.liberar();
    return { a, pedido, troca };
}

for (const [rotulo, antiga] of [['sem usuário', 'sem-usuario'], ['401', 401]] as const) {
    test(`pós-confirmação obsoleta (${rotulo}) ANTES da recusa da troca (403): espera o resultado, entrega a lista e mantém a busca`, async () => {
        const { a, pedido, troca } = await respostaAntigaComTrocaPendente(antiga, S1, 403);
        assert.equal(await troca, null, 'a recusa chega como resposta, sem navegar');
        assert.equal(await pedido, null, 'a lista é entregue');
        assert.equal(a.leiturasFeitas(), 4, 'uma releitura depois do resultado da troca');
        assert.deepEqual(a.navegacoes, [], 'sem login nem descarte');
        assert.equal(a.aba.lerBuscaDaAba('contratos'), 'Helena', 'a busca continua');
        a.aba.guardarBuscaNaAba('contratos', 'Theo');
        assert.equal(a.aba.lerBuscaDaAba('contratos'), 'Theo', 'e continua gravável');
    });
}

test('pós-confirmação obsoleta ANTES da conclusão da troca: espera, revalida, vê a sessão nova e descarta, travando a busca', async () => {
    const { a, pedido, troca } = await respostaAntigaComTrocaPendente('sem-usuario', S2, 200);
    assert.equal(await troca, null);
    assert.equal((await pedido)?.tipo, 'CONTEXTO_MUDOU');
    assert.deepEqual(a.navegacoes, ['replace:/admin/dashboard']);
    travada(a);
});

for (const natureza of ['leitura', 'escrita'] as const) {
    test(`troca pendente sem resultado no prazo (${natureza}): nada entregue, descartado, travado ou navegado`, async () => {
        mock.timers.enable({ apis: ['setTimeout'] });
        const r = retida(), p = postRetido();
        const a = ambiente([S1, r.passo, S1, S1], { status: 403, segurar: p.segurar });
        try {
            let resolvido = false;
            const pedido = erroDe(((natureza === 'leitura' ? a.mod.adminFetch(LISTA) : a.mod.adminFetch(ESCRITA, { method: 'POST', body: '{}' })) as Promise<Response>)
                .finally(() => { resolvido = true; }));
            await r.pedida;
            const troca = erroDe(a.mod.trocarEmpresaAtiva('B'));
            while (a.posts() < (natureza === 'leitura' ? 1 : 2)) await tique();
            r.soltar('sem-usuario');
            for (let i = 0; i < 30; i++) await tique();
            mock.timers.tick((a.mod.PRAZO_ESPERA_DA_TROCA_MS as unknown as number) - 1);
            for (let i = 0; i < 30; i++) await tique();
            assert.equal(resolvido, false, 'ainda esperando dentro do prazo');
            mock.timers.tick(1);
            const e = await pedido;
            assert.equal(e?.tipo, 'SESSAO_NAO_CONFIRMADA');
            const esperado = natureza === 'leitura' ? a.mod.AVISO_LEITURA_EM_VERIFICACAO : a.mod.AVISO_ESCRITA_EM_VERIFICACAO;
            assert.equal(e?.message, esperado);
            if (natureza === 'escrita') assert.equal(a.armazenado.get('kidmais-aviso-contexto'), esperado, 'o resultado real da escrita fica registrado');
            assert.equal(a.leiturasFeitas(), 3, 'nada é relido sem o resultado da troca');
            assert.deepEqual(a.navegacoes, [], 'sem login nem descarte');
            assert.equal(a.aba.lerBuscaDaAba('contratos'), 'Helena', 'a busca continua');
            p.liberar();
            assert.equal(await troca, null);
        } finally {
            p.liberar();
            mock.timers.reset();
        }
    });
}

test('teto de releituras esgotado com nova troca desta página em curso: nada entregue nem decidido pela resposta antiga', async () => {
    const r = retida();
    let trocas = 0;
    // Cada releitura sai antes de uma nova troca desta página e volta antiga; as duas primeiras trocas terminam logo, a última não.
    const gira = async (): Promise<Leitura> => {
        a.ctx.iniciarTrocaDeEmpresa();
        if (++trocas < 3) setImmediate(() => a.ctx.encerrarTrocaDeEmpresa());
        return 'sem-usuario';
    };
    const a = ambiente([S1, r.passo, gira, gira, gira]);
    try {
        const pedido = erroDe(a.mod.adminFetch(LISTA));
        await r.pedida;
        a.ctx.iniciarTrocaDeEmpresa(); a.ctx.encerrarTrocaDeEmpresa();
        r.soltar('sem-usuario');
        const e = await pedido;
        assert.equal(a.leiturasFeitas(), 5, 'pós-confirmação e três releituras');
        assert.equal(e?.tipo, 'SESSAO_NAO_CONFIRMADA');
        assert.deepEqual(a.navegacoes, [], 'sem login nem descarte');
        assert.equal(a.aba.lerBuscaDaAba('contratos'), 'Helena', 'a busca continua');
    } finally { a.ctx.encerrarTrocaDeEmpresa(); }
});
