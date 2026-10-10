import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { carregarModulo } from '../acessos/teste-carregador.ts';
import { csrfParaSessaoInvalida } from './csrf-sem-sessao.ts';

/**
 * Corrida da troca de empresa (10/10/2026): a troca revoga a sessão atual e cria outra. Uma leitura da sessão que saiu
 * antes da troca e chegou ao servidor depois dela (1) respondia "sessão encerrada" e mandava a página ao login e
 * (2) gravava um CSRF novo por cima do CSRF da sessão nova — derrubando a sessão nova. Sem navegador: globais falsos e
 * os módulos reais (admin-fetch + contexto-empresa-cliente na MESMA instância), com respostas em ordem controlada.
 */
const SESSAO_A = { sessaoId: 's-alfa', empresa: 'alfa' };
const SESSAO_B = { sessaoId: 's-beta', empresa: 'beta' };
function ambiente() {
    const navegacoes: string[] = [];
    const armazenado = new Map<string, string>();
    const g = globalThis as unknown as Record<string, unknown>;
    g.window = { location: { pathname: '/admin/clientes', replace: (u: string) => navegacoes.push(u), assign: (u: string) => navegacoes.push(u) } };
    g.sessionStorage = { getItem: (k: string) => armazenado.get(k) ?? null, setItem: (k: string, v: string) => armazenado.set(k, v), removeItem: (k: string) => armazenado.delete(k) };
    /** Sessão que o servidor reconhece agora; `null` = encerrada. A troca a substitui. */
    let vigente: typeof SESSAO_A | null = SESSAO_A;
    const envios: string[] = [];
    const portas: Array<{ url: string; abrir: () => void }> = [];
    /** Respostas de leitura da sessão presas: cada uma responde com a sessão vigente NO MOMENTO em que é liberada. */
    const segurarProximaLeitura = () => { let abrir!: () => void; const p = new Promise<void>((r) => { abrir = r; }); portas.push({ url: '/api/admin/autenticacao', abrir }); return { p, abrir: () => abrir() }; };
    let leituraPresa: Promise<void> | null = null;
    const respostas = new Map<string, { status: number; antes?: () => void } | 'rede'>();
    g.fetch = async (input: string, init: RequestInit = {}) => {
        const url = String(input);
        const metodo = (init.method ?? 'GET').toUpperCase();
        if (url === '/api/admin/autenticacao' && metodo === 'GET') {
            if (leituraPresa) { const p = leituraPresa; leituraPresa = null; await p; }
            const s = vigente;
            return new Response(JSON.stringify({ ok: true, data: s ? { usuarioId: 'u', sessaoId: s.sessaoId, csrf: 'c', contexto: { empresaAtual: { id: s.empresa } } } : { usuarioId: null, csrf: 'c' } }));
        }
        envios.push(`${metodo} ${url}`);
        const r = respostas.get(url);
        if (!r) throw new Error(`rota sem resposta: ${url}`);
        if (r === 'rede') throw new TypeError('fetch failed');
        r.antes?.();
        return new Response('{"ok":true}', { status: r.status });
    };
    const cache = new Map();
    const ctx = carregarModulo('lib/http/contexto-empresa-cliente.ts', {}, cache) as Record<string, ((...a: unknown[]) => unknown) | undefined>;
    const mod = carregarModulo('lib/http/admin-fetch.ts', {}, cache) as { adminFetch: (u: string, i?: RequestInit) => Promise<Response> };
    return {
        mod, navegacoes, envios, respostas,
        /** O que a troca de empresa da página faz: marca o início (se existir) e o servidor passa para a sessão Beta. */
        iniciarTroca: () => { ctx.iniciarTrocaDeEmpresa?.(); },
        encerrarTroca: () => { ctx.encerrarTrocaDeEmpresa?.(); },
        trocarNoServidor: () => { vigente = SESSAO_B; },
        encerrarNoServidor: () => { vigente = null; },
        /** A próxima leitura GET da sessão fica presa até `liberar` e responde com a sessão vigente ao ser liberada. */
        prenderLeitura: () => { const s = segurarProximaLeitura(); leituraPresa = s.p; return s.abrir; },
        aviso: () => armazenado.get('kidmais-aviso-contexto') ?? null,
        login: () => navegacoes.filter((n) => n.startsWith('/admin/login')).length,
    };
}
const mensagem = (p: Promise<unknown>) => p.then(() => 'OK', (e: Error) => e.message);
const tique = () => new Promise((r) => setTimeout(r, 5));

test('troca: leitura que saiu ANTES da troca e voltou "encerrada" DEPOIS → não manda ao login; nada entregue; nada enviado', async () => {
    const a = ambiente();
    a.respostas.set('/api/x', { status: 200 });
    const liberar = a.prenderLeitura();               // confirmação prévia da leitura sai com a sessão Alfa
    const leitura = mensagem(a.mod.adminFetch('/api/x'));
    await tique();
    a.iniciarTroca(); a.encerrarNoServidor();         // a troca começa; a sessão Alfa é revogada
    liberar();                                        // a resposta antiga chega: "encerrada"
    assert.match(await leitura, /mudou/);
    assert.equal(a.login(), 0, 'resposta da sessão anterior não manda ao login');
    assert.equal(a.envios.length, 0, 'nada é enviado com a sessão anterior');
});

test('troca: escrita executada, troca durante a resposta e confirmação "encerrada" obsoleta → aviso "concluída", painel (não login), um envio', async () => {
    const a = ambiente();
    a.respostas.set('/api/x', { status: 200, antes: () => { a.iniciarTroca(); a.encerrarNoServidor(); } });
    const escrita = await mensagem(a.mod.adminFetch('/api/x', { method: 'POST', body: '{}' }));
    assert.match(escrita, /concluída antes da mudança/);
    assert.match(a.aviso() ?? '', /concluída antes da mudança/, 'o resultado real da escrita é avisado');
    assert.equal(a.login(), 0, 'não vai ao login');
    assert.deepEqual(a.navegacoes, ['/admin/dashboard']);
    assert.deepEqual(a.envios, ['POST /api/x'], 'executada uma única vez, sem repetição');
});

test('troca: escrita com 5xx e confirmação obsoleta → "Resultado incerto", nunca "concluída"; sem login; um envio', async () => {
    const a = ambiente();
    a.respostas.set('/api/x', { status: 503, antes: () => { a.iniciarTroca(); a.encerrarNoServidor(); } });
    assert.match(await mensagem(a.mod.adminFetch('/api/x', { method: 'POST', body: '{}' })), /Resultado incerto/);
    assert.doesNotMatch(a.aviso() ?? '', /concluída antes da mudança/, 'sem confirmação falsa de conclusão');
    assert.equal(a.login(), 0);
    assert.equal(a.envios.length, 1);
});

test('sessão REALMENTE encerrada (sem troca nesta página) → login, como antes', async () => {
    const a = ambiente();
    a.encerrarNoServidor();
    assert.match(await mensagem(a.mod.adminFetch('/api/x')), /login/i);
    assert.equal(a.login(), 1);
    assert.equal(a.envios.length, 0);
});

test('troca recusada e sessão realmente encerrada: uma leitura NOVA, depois da troca falhar, vai ao login (revogação real respeitada)', async () => {
    const a = ambiente();
    a.iniciarTroca(); a.encerrarNoServidor();         // a troca falhou e a sessão acabou de verdade
    a.encerrarTroca();                                // AdminShell: catch da troca
    assert.match(await mensagem(a.mod.adminFetch('/api/x')), /login/i);
    assert.equal(a.login(), 1);
});

test('leitura que sai DURANTE a troca (cookies da sessão anterior) e volta "encerrada" → obsoleta, sem login', async () => {
    const a = ambiente();
    a.iniciarTroca();                                 // troca em curso; o POST ainda não voltou
    a.encerrarNoServidor();                           // o servidor já revogou a sessão anterior
    assert.match(await mensagem(a.mod.adminFetch('/api/x')), /mudou/);
    assert.equal(a.login(), 0);
    assert.equal(a.envios.length, 0);
});

test('trocas rápidas consecutivas: respostas antigas das duas gerações chegam depois → nenhuma manda ao login', async () => {
    const a = ambiente();
    a.respostas.set('/api/x', { status: 200 });
    const liberar1 = a.prenderLeitura();
    const l1 = mensagem(a.mod.adminFetch('/api/x'));
    await tique();
    a.iniciarTroca(); a.trocarNoServidor();            // 1ª troca: Alfa → Beta
    const liberar2 = a.prenderLeitura();
    const l2 = mensagem(a.mod.adminFetch('/api/x'));
    await tique();
    a.iniciarTroca(); a.encerrarNoServidor();          // 2ª troca: a sessão Beta também é revogada
    liberar2(); liberar1();
    await l1; await l2;
    assert.equal(a.login(), 0, 'respostas obsoletas não mandam ao login');
});

test('sessão inválida no servidor: CSRF existente e bem formado é reaproveitado (não gravado de novo); ausente ou inválido gera outro', () => {
    const atual = 'A'.repeat(43);
    assert.deepEqual(csrfParaSessaoInvalida(atual), { csrf: atual, gravar: false }, 'resposta antiga não troca o CSRF da sessão nova');
    for (const ruim of [undefined, '', 'curto', `${'A'.repeat(42)}!`, 'A'.repeat(44)]) {
        const r = csrfParaSessaoInvalida(ruim);
        assert.equal(r.gravar, true, String(ruim));
        assert.match(r.csrf, /^[A-Za-z0-9_-]{43}$/);
    }
    const rota = readFileSync('app/api/admin/autenticacao/route.ts', 'utf8');
    assert.match(rota, /const \{ csrf, gravar \} = csrfParaSessaoInvalida\(request\.cookies\.get\(policy\.csrfCookie\)\?\.value\);\s*const res = response\(\{ ok: true, data: \{ usuarioId: null, csrf \} \}\);\s*if \(gravar\)\s*res\.cookies\.set\(policy\.csrfCookie, csrf,/);
    assert.equal(rota.match(/randomBytes\(/g)?.length ?? 0, 0, 'nenhum CSRF novo gravado incondicionalmente na rota');
});

test('AdminShell: a troca marca o início ANTES do POST; leituras do shell que saíram antes ignoram a resposta (sem login)', () => {
    const shell = readFileSync('components/admin/AdminShell.tsx', 'utf8');
    assert.match(shell, /const carregar = \(\) => \{ const marca = marcaDaSessao\(\); return fetch\('\/api\/admin\/autenticacao'[\s\S]*?if \(sessaoObsoletaDesde\(marca\)\)\s*return;\s*if \(!b\.ok \|\| !b\.data\.usuarioId\) \{/);
    assert.match(shell, /\.catch\(\(\) => \{ if \(!sessaoObsoletaDesde\(marca\)\) router\.replace\('\/admin\/login'\); \}\);/);
    assert.match(shell, /iniciarTrocaDeEmpresa\(\);\s*try \{\s*const res = await adminFetch\('\/api\/admin\/autenticacao', \{ method: 'POST'/);
});
