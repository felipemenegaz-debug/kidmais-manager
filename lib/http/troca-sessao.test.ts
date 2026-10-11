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
    /** A leitura presa leva os cookies da sessão de quando saiu: liberada depois da revogação, volta "encerrada". */
    let presaComSessaoAnterior = false;
    const respostas = new Map<string, { status: number; antes?: () => void } | 'rede'>();
    g.fetch = async (input: string, init: RequestInit = {}) => {
        const url = String(input);
        const metodo = (init.method ?? 'GET').toUpperCase();
        if (url === '/api/admin/autenticacao' && metodo === 'GET') {
            let s = vigente;
            if (leituraPresa) { const p = leituraPresa; const antiga = presaComSessaoAnterior; leituraPresa = null; presaComSessaoAnterior = false; await p; s = antiga ? null : vigente; }
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
    const mod = carregarModulo('lib/http/admin-fetch.ts', {}, cache) as { adminFetch: (u: string, i?: RequestInit) => Promise<Response>; trocarEmpresaAtiva?: (id: string) => Promise<Response> };
    return {
        mod, navegacoes, envios, respostas,
        /** O que a troca de empresa da página faz: marca o início (se existir) e o servidor passa para a sessão Beta. */
        iniciarTroca: () => { ctx.iniciarTrocaDeEmpresa?.(); },
        encerrarTroca: () => { ctx.encerrarTrocaDeEmpresa?.(); },
        trocarNoServidor: () => { vigente = SESSAO_B; },
        encerrarNoServidor: () => { vigente = null; },
        /** A próxima leitura GET da sessão fica presa até `liberar` e responde com a sessão vigente ao ser liberada. */
        prenderLeitura: (comSessaoAnterior = false) => { const s = segurarProximaLeitura(); leituraPresa = s.p; presaComSessaoAnterior = comSessaoAnterior; return s.abrir; },
        /**
         * A troca como o AdminShell a faz: com a correção, trocarEmpresaAtiva; antes dela (271f18b), marcar o início e enviar o
         * POST pelo adminFetch. Depois do sucesso, o AdminShell pede o descarte (navegação); aqui a navegação só é registrada:
         * a página "fica", como no "Ficar" do aviso de alterações não salvas.
         */
        trocarPelaPagina: async () => {
            respostas.set('/api/admin/autenticacao', { status: 200, antes: () => { vigente = SESSAO_B; } });
            if (mod.trocarEmpresaAtiva) await mod.trocarEmpresaAtiva('beta');
            else { ctx.iniciarTrocaDeEmpresa?.(); await mod.adminFetch('/api/admin/autenticacao', { method: 'POST', body: '{}' }); }
            ctx.reiniciarContextoEmpresa?.();
        },
        tentarTrocarPelaPagina: async () => {
            respostas.set('/api/admin/autenticacao', { status: 200, antes: () => { vigente = SESSAO_B; } });
            try {
                if (mod.trocarEmpresaAtiva) await mod.trocarEmpresaAtiva('beta');
                else { ctx.iniciarTrocaDeEmpresa?.(); await mod.adminFetch('/api/admin/autenticacao', { method: 'POST', body: '{}' }); }
                return 'OK';
            }
            catch (e) { ctx.encerrarTrocaDeEmpresa?.(); return (e as Error).message; }
        },
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

test('AdminShell: leituras do shell que saíram antes ou durante a troca ignoram a resposta (sem login)', () => {
    const shell = readFileSync('components/admin/AdminShell.tsx', 'utf8');
    assert.match(shell, /const carregar = \(\) => \{ const marca = marcaDaSessao\(\); return fetch\('\/api\/admin\/autenticacao'[\s\S]*?if \(sessaoObsoletaDesde\(marca\)\)\s*return;\s*if \(!b\.ok \|\| !b\.data\.usuarioId\) \{/);
    assert.match(shell, /\.catch\(\(\) => \{ if \(!sessaoObsoletaDesde\(marca\)\) router\.replace\('\/admin\/login'\); \}\);/);
});

// ---------------------------------------------------------------- B1, B2 e aviso perdido (parecer de 11/10/2026)

test('B1: troca concluída e navegação cancelada ("Ficar") → logout REAL depois → login (a janela da troca terminou)', async () => {
    const a = ambiente();
    await a.trocarPelaPagina();                       // a troca concluiu; a navegação foi pedida e cancelada
    const navegacoesDaTroca = a.navegacoes.length;
    a.encerrarNoServidor();                           // logout em outra aba / revogação real
    assert.match(await mensagem(a.mod.adminFetch('/api/x')), /login/i);
    assert.equal(a.login(), 1, 'fim real da sessão leva ao login mesmo com a página ainda aberta');
    assert.equal(a.navegacoes.length, navegacoesDaTroca + 1);
});

test('B1: troca concluída e navegação cancelada → expiração depois → login; antes disso, dados da empresa anterior descartados', async () => {
    const a = ambiente();
    a.respostas.set('/api/x', { status: 200 });
    await a.trocarPelaPagina();
    // Página ainda com o contexto Alfa; a sessão agora é Beta: a leitura é descartada (nada entregue), sem login.
    assert.match(await mensagem(a.mod.adminFetch('/api/x')), /mudou/);
    assert.equal(a.login(), 0);
    a.encerrarNoServidor();                           // a sessão Beta expira
    assert.match(await mensagem(a.mod.adminFetch('/api/x')), /login/i);
    assert.equal(a.login(), 1);
});

test('B2: sessão já inválida ANTES da troca → a troca vai direto ao login (não é resposta obsoleta); nenhum POST de troca', async () => {
    const a = ambiente();
    a.encerrarNoServidor();
    const r = await a.tentarTrocarPelaPagina();
    assert.match(r, /login/i, 'a pessoa é levada ao login');
    assert.equal(a.login(), 1);
    assert.equal(a.envios.filter((e) => e.startsWith('POST')).length, 0, 'nenhum POST de troca com sessão inválida');
});

test('aviso perdido: escrita impedida antes do envio pela troca → aviso claro de que nada foi enviado nem salvo; zero envios', async () => {
    const a = ambiente();
    a.respostas.set('/api/y', { status: 200 });
    const liberar = a.prenderLeitura(true);           // confirmação prévia da escrita sai com a sessão Alfa
    const escrita = mensagem(a.mod.adminFetch('/api/y', { method: 'POST', body: '{}' }));
    await tique();
    await a.trocarPelaPagina();                       // a troca acontece; a Alfa é revogada
    liberar();                                        // a confirmação prévia da escrita volta "encerrada" (sessão anterior)
    assert.match(await escrita, /Nada foi enviado/);
    assert.match(a.aviso() ?? '', /Nada foi enviado nem salvo/, 'a próxima tela informa que nada foi salvo');
    assert.equal(a.envios.filter((e) => e === 'POST /api/y').length, 0, 'a escrita não saiu');
    assert.equal(a.login(), 0);
});

test('leitura antiga depois de uma troca válida → descartada, sem login (proteção preservada)', async () => {
    const a = ambiente();
    a.respostas.set('/api/x', { status: 200 });
    const liberar = a.prenderLeitura(true);
    const leitura = mensagem(a.mod.adminFetch('/api/x'));
    await tique();
    await a.trocarPelaPagina();
    liberar();
    assert.match(await leitura, /mudou/);
    assert.equal(a.login(), 0);
});

test('escrita concluída com troca durante a resposta → aviso "concluída" preservado e um único envio', async () => {
    const a = ambiente();
    a.respostas.set('/api/z', { status: 200, antes: () => { a.iniciarTroca(); a.encerrarNoServidor(); } });
    assert.match(await mensagem(a.mod.adminFetch('/api/z', { method: 'POST', body: '{}' })), /concluída antes da mudança/);
    assert.match(a.aviso() ?? '', /concluída antes da mudança/);
    assert.deepEqual(a.envios.filter((e) => e === 'POST /api/z'), ['POST /api/z']);
    assert.equal(a.login(), 0);
});

test('AdminShell: a troca usa trocarEmpresaAtiva e o seletor volta a funcionar se a navegação for cancelada', () => {
    const shell = readFileSync('components/admin/AdminShell.tsx', 'utf8');
    assert.match(shell, /const res = await trocarEmpresaAtiva\(id\);/);
    assert.match(shell, /reiniciarContextoEmpresa\(\);[\s\S]{0,300}?window\.setTimeout\(\(\) => setTrocando\(false\), ESPERA_NAVEGACAO_DA_TROCA_MS\);/);
    assert.doesNotMatch(shell, /iniciarTrocaDeEmpresa\(\)/, 'o início da troca fica com trocarEmpresaAtiva, depois da confirmação prévia');
    const af = readFileSync('lib/http/admin-fetch.ts', 'utf8');
    const troca = af.slice(af.indexOf('export async function trocarEmpresaAtiva('));
    assert.ok(af.includes('export async function trocarEmpresaAtiva(') && troca.indexOf('await confirmarSessao()') < troca.indexOf('iniciarTrocaDeEmpresa()'), 'confirma a sessão antes de marcar o início');
    assert.match(troca, /finally \{[\s\S]*?encerrarTrocaDeEmpresa\(\);[\s\S]*?\}/, 'a janela termina quando a resposta do POST chega (ou falha)');
});
