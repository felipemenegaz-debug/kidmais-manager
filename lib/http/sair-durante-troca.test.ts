import assert from 'node:assert/strict';
import test from 'node:test';
import { carregarModulo } from '../acessos/teste-carregador.ts';

/**
 * P4: Sair durante a troca de empresa. A troca revoga a sessão Alfa e cria Beta; um logout que sai com os cookies Alfa
 * e chega depois da troca recebe 401, e a Beta (cookie já gravado pela resposta da troca) ficava aberta.
 * Módulos reais (contexto-empresa-cliente, admin-fetch, sair, na MESMA instância). Servidor e pote de cookies são
 * modelos: cada pedido leva o cookie do momento do ENVIO; a resposta da troca grava o cookie novo quando chega.
 */
type Porta = { abrir: () => void; aberta: Promise<void> };
const porta = (): Porta => { let abrir!: () => void; const aberta = new Promise<void>((r) => { abrir = r; }); return { abrir, aberta }; };
const tique = () => new Promise((r) => setTimeout(r, 5));
const CSRF_ALFA = 'A'.repeat(43);
const CSRF_BETA = 'B'.repeat(43);
type Saida = { motivo: string; confirmada: boolean; pedidos: number };

function ambiente() {
    const navegacoes: string[] = [];
    const armazenado = new Map<string, string>();
    const g = globalThis as unknown as Record<string, unknown>;
    g.window = { location: { pathname: '/admin/clientes', replace: (u: string) => navegacoes.push(`replace:${u}`), assign: (u: string) => navegacoes.push(`assign:${u}`) } };
    g.sessionStorage = { getItem: (k: string) => armazenado.get(k) ?? null, setItem: (k: string, v: string) => armazenado.set(k, v), removeItem: (k: string) => armazenado.delete(k) };
    // Servidor: sessão válida -> { empresa, csrf }. Navegador: cookie atual.
    const validas = new Map<string, { empresa: string; csrf: string }>([['s-alfa', { empresa: 'alfa', csrf: CSRF_ALFA }]]);
    let cookie: string | null = 's-alfa';
    const envios: string[] = [];
    const portas: Record<string, Porta | null> = { troca: null, logout: null, get: null };
    let trocaFalha: number | 'rede' | 'rede-depois-de-processar' | null = null;
    let logoutFalha: 'rede' | null = null;
    const fetchFalso = async (input: string, init: RequestInit = {}) => {
        const metodo = (init.method ?? 'GET').toUpperCase();
        const sessao = cookie; // cookies anexados no envio
        const csrf = new Headers(init.headers).get('x-csrf-token');
        if (metodo === 'GET') {
            envios.push(`GET ${sessao}`);
            if (portas.get) { const p = portas.get; portas.get = null; await p.aberta; }
            const v = sessao ? validas.get(sessao) : undefined;
            return new Response(JSON.stringify(v
                ? { ok: true, data: { usuarioId: 'u', sessaoId: sessao, csrf: v.csrf, contexto: { empresaAtual: { id: v.empresa } } } }
                : { ok: true, data: { usuarioId: null, csrf: CSRF_ALFA } }));
        }
        const acao = (JSON.parse(String(init.body ?? '{}')) as { acao?: string }).acao;
        envios.push(`POST ${acao} ${sessao}`);
        if (acao === 'selecionar-empresa') {
            // Falhas: a resposta só chega quando a porta abre. Sucesso: o servidor processa ao receber (Alfa revogada,
            // Beta criada) e a RESPOSTA, com o Set-Cookie da Beta, chega quando a porta abre.
            if (trocaFalha === 'rede-depois-de-processar') {
                // O servidor processou (Alfa revogada, Beta criada), mas a resposta não chega: nenhum Set-Cookie aplicado.
                if (sessao && validas.has(sessao)) { validas.delete(sessao); validas.set('s-beta', { empresa: 'beta', csrf: CSRF_BETA }); }
                if (portas.troca) await portas.troca.aberta;
                throw new TypeError('fetch failed');
            }
            if (trocaFalha) {
                if (portas.troca) await portas.troca.aberta;
                if (trocaFalha === 'rede') throw new TypeError('fetch failed');
                return new Response('{"ok":false}', { status: trocaFalha });
            }
            if (!sessao || !validas.has(sessao)) return new Response('{"ok":false}', { status: 401 });
            validas.delete(sessao);
            validas.set('s-beta', { empresa: 'beta', csrf: CSRF_BETA });
            if (portas.troca) await portas.troca.aberta;
            cookie = 's-beta'; // Set-Cookie aplicado quando a resposta chega
            return new Response(JSON.stringify({ ok: true, data: { csrf: CSRF_BETA } }));
        }
        if (acao === 'logout') {
            if (portas.logout) await portas.logout.aberta;
            if (logoutFalha === 'rede') throw new TypeError('fetch failed');
            const v = sessao ? validas.get(sessao) : undefined;
            if (!v) return new Response('{"ok":false}', { status: 401 }); // sem Set-Cookie
            if (csrf !== v.csrf) return new Response('{"ok":false}', { status: 403 });
            validas.delete(sessao!);
            cookie = null;
            return new Response('{"ok":true}');
        }
        throw new Error(`rota sem modelo: ${metodo} ${acao}`);
    };
    g.fetch = fetchFalso;
    const cache = new Map<string, Record<string, unknown>>();
    const ctx = carregarModulo('lib/http/contexto-empresa-cliente.ts', {}, cache) as Record<string, (...a: unknown[]) => unknown>;
    const af = carregarModulo('lib/http/admin-fetch.ts', {}, cache) as Record<string, (...a: unknown[]) => Promise<Response>>;
    const sair = carregarModulo('components/admin/sair.ts', {}, cache) as Record<string, (...a: unknown[]) => unknown>;
    (sair.reiniciarSaidaParaTestes as () => void)();
    (sair.lembrarCsrf as (c: string) => void)(CSRF_ALFA);
    const avisos: string[] = [];
    const destinos: string[] = [];
    return {
        ctx, af, envios, validas, avisos, destinos,
        cookie: () => cookie,
        prender: (qual: 'troca' | 'logout' | 'get') => (portas[qual] = porta()),
        falharTroca: (f: number | 'rede' | 'rede-depois-de-processar') => { trocaFalha = f; },
        falharLogout: (f: 'rede') => { logoutFalha = f; },
        sair: (prazoMs?: number) => (sair.sairDaSessao as (d: unknown) => Promise<Saida>)({ fetch: fetchFalso, navegar: (d: string) => destinos.push(d), avisar: (x: string) => avisos.push(x), prazoMs }),
    };
}
const msg = (p: Promise<unknown>) => p.then(() => 'OK', (e: Error) => e.message);

test('P4: Sair com a troca já enviada encerra a sessão criada pela troca (Beta); nenhuma sessão fica válida', async () => {
    const a = ambiente();
    const t = a.prender('troca');
    const troca = msg(a.af.trocarEmpresaAtiva('beta'));
    await tique(); // POST da troca enviado com Alfa, ainda sem resposta
    const saida = a.sair();
    await tique(); // Sair clicado durante a troca
    t.abrir();
    await troca;
    const r = await saida;
    assert.equal(r.motivo, 'CONFIRMADA', 'o servidor confirmou o encerramento');
    assert.equal(a.validas.size, 0, 'nenhuma sessão continua válida no servidor');
    assert.equal(a.cookie(), null, 'o navegador ficou sem cookie de sessão');
    assert.deepEqual(a.destinos, ['/admin/login']);
    assert.deepEqual(a.avisos, []);
    assert.ok(r.pedidos <= 2, 'no máximo uma leitura e um POST de saída');
    assert.ok(a.envios.includes('POST logout s-beta'), 'o logout saiu com a sessão vigente (Beta)');
});

test('P4: Sair durante a confirmação prévia da troca impede o POST da troca; a sessão Alfa é encerrada e nenhuma Beta é criada', async () => {
    const a = ambiente();
    const g = a.prender('get');
    const l = a.prender('logout');
    const troca = msg(a.af.trocarEmpresaAtiva('beta'));
    await tique(); // leitura prévia da troca enviada
    const saida = a.sair();
    await tique(); // logout enviado com Alfa, sem resposta
    g.abrir();
    const resultadoTroca = await troca; // prévia válida (Alfa ainda vale)
    l.abrir();
    const r = await saida;
    assert.equal(r.motivo, 'CONFIRMADA');
    assert.ok(!a.envios.some((e) => e.startsWith('POST selecionar-empresa')), 'nenhum POST de troca depois do Sair');
    assert.notEqual(resultadoTroca, 'OK', 'a troca não acontece');
    assert.equal(a.validas.size, 0, 'nenhuma sessão válida');
    assert.equal(a.cookie(), null);
});

test('P4: troca sem resposta dentro do prazo de saída → PRAZO_ESGOTADO com o aviso de que a sessão pode continuar aberta (não finge sucesso)', async () => {
    const a = ambiente();
    a.prender('troca');
    void msg(a.af.trocarEmpresaAtiva('beta'));
    await tique();
    const r = await a.sair(60);
    assert.equal(r.motivo, 'PRAZO_ESGOTADO');
    assert.equal(r.confirmada, false);
    assert.ok(!a.envios.some((e) => e.startsWith('POST logout')), 'nenhum logout com a sessão Alfa, já revogada pela troca');
    assert.equal(a.avisos.length, 1);
    assert.match(a.avisos[0]!, /pode continuar aberta/);
    assert.deepEqual(a.destinos, ['/admin/login']);
});

for (const falha of [409, 'rede'] as const) {
    test(`P4: troca que falha (${falha}) durante o Sair → a saída encerra a sessão Alfa, que continua sendo a vigente`, async () => {
        const a = ambiente();
        a.falharTroca(falha);
        const t = a.prender('troca');
        const troca = msg(a.af.trocarEmpresaAtiva('beta'));
        await tique();
        const saida = a.sair();
        await tique();
        t.abrir();
        await troca;
        const r = await saida;
        assert.equal(r.motivo, 'CONFIRMADA');
        assert.equal(a.validas.size, 0);
        assert.equal(a.cookie(), null);
    });
}

test('guarda: Sair sem troca em curso continua com um único POST, usando o CSRF lembrado', async () => {
    const a = ambiente();
    const r = await a.sair();
    assert.deepEqual([r.motivo, r.pedidos], ['CONFIRMADA', 1]);
    assert.deepEqual(a.envios, ['POST logout s-alfa']);
    assert.equal(a.validas.size, 0);
});

test('guarda: Sair depois de a troca responder encerra a Beta (comportamento anterior preservado)', async () => {
    const a = ambiente();
    assert.equal(await msg(a.af.trocarEmpresaAtiva('beta')), 'OK');
    const r = await a.sair();
    assert.equal(r.motivo, 'CONFIRMADA');
    assert.equal(a.validas.size, 0);
    assert.equal(a.cookie(), null);
});

test('P4: resultado desconhecido — logout sem resposta depois da troca → NAO_CONFIRMADA com aviso de que a sessão pode continuar aberta', async () => {
    const a = ambiente();
    a.falharLogout('rede');
    const t = a.prender('troca');
    const troca = msg(a.af.trocarEmpresaAtiva('beta'));
    await tique();
    const saida = a.sair();
    await tique();
    t.abrir();
    await troca;
    const r = await saida;
    assert.equal(r.motivo, 'NAO_CONFIRMADA');
    assert.equal(r.confirmada, false);
    assert.equal(a.avisos.length, 1, 'um aviso, e honesto');
    assert.match(a.avisos[0]!, /pode continuar aberta/);
    assert.ok(a.envios.includes('POST logout s-beta'), 'a tentativa foi com a sessão vigente (Beta)');
    assert.deepEqual(a.destinos, ['/admin/login']);
});

test('P4: troca processada no servidor com a resposta perdida → o navegador não recebe a Beta; a saída não declara encerramento de algo que não conhece (limitação L3)', async () => {
    const a = ambiente();
    a.falharTroca('rede-depois-de-processar');
    const t = a.prender('troca');
    const troca = msg(a.af.trocarEmpresaAtiva('beta'));
    await tique();
    const saida = a.sair();
    await tique();
    t.abrir();
    await troca;
    const r = await saida;
    assert.notEqual(a.cookie(), 's-beta', 'nenhum navegador tem o cookie da Beta');
    assert.equal(r.confirmada, false, 'não confirma o encerramento');
    assert.equal(a.validas.get('s-beta')?.empresa, 'beta', 'registrado: a Beta fica válida no servidor sem cookie em lugar nenhum (L3)');
    assert.deepEqual(a.destinos, ['/admin/login']);
});
