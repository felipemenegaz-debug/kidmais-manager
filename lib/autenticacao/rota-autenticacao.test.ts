import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { carregarModulo } from '../acessos/teste-carregador.ts';

/**
 * Recorte 4 para production (P2-2 do Astra): prova COMPORTAMENTAL da rota app/api/admin/autenticacao/route.ts.
 * O POST real é chamado com Request real (NextRequest do Next), e a política de origem e o CSRF são os reais
 * (lib/http/admin-crm-api.ts, admin-origin.ts, senha.ts). Só o serviço de login e as leituras de tela são dublados;
 * o login em si (fases, scrypt fora do pool, corrida) é provado no PostgreSQL descartável em
 * lib/autenticacao/login-origem.postgres.test.ts. Cobre: cookies da sessão, CSRF, Retry-After, logout,
 * reautenticação e o IP que a rota entrega ao login (null com a borda desligada; o penúltimo XFF conferido com
 * CF-Connecting-IP com a borda confirmada). Nenhum dado real; endereços de documentação ou sintéticos.
 */
const ORIGEM = 'https://admin.exemplo.test';
const URL_ROTA = `${ORIGEM}/api/admin/autenticacao`;
const COOKIE = '__Host-kidmais_admin';
const COOKIE_CSRF = '__Host-kidmais_admin_csrf';
const CSRF = 'c'.repeat(43);
const TOKEN = 't'.repeat(43);
const EXPIRA = new Date('2030-01-01T00:00:00.000Z');

type Chamada = { acao: string; args: unknown[] };
const chamadas: Chamada[] = [];
let respostaLogin: () => Promise<unknown> = async () => ({ token: 'novo-token', csrf: 'novo-csrf', expires: EXPIRA });

const cache = new Map<string, Record<string, unknown>>();
const erros = carregarModulo('lib/clientes/services/errors.ts', {}, cache) as { ClienteServiceError: new (c: string, m: string, s: number, d?: unknown) => Error };
const senha = carregarModulo('lib/autenticacao/senha.ts', {}, cache) as { hashToken: (v: string) => string };
const authError = (message = 'Autenticação administrativa necessária.', status = 401, details?: Record<string, unknown>) =>
    new erros.ClienteServiceError('AUTENTICACAO_ADMINISTRATIVA', message, status, details);
class PacoteAdminError extends Error {}

const sessao = { id: 'sessao-anterior', usuario_id: 'usuario-1', csrf_hash: senha.hashToken(CSRF), nome: 'Pessoa', papel: 'REPRESENTANTE_AUTORIZADO', empresa_ativa_id: null };
const rota = carregarModulo('app/api/admin/autenticacao/route.ts', {
    // Banco: só o toque de atividade da sessão (exigirApiAdminCrmDisponivel); qualquer outro SQL falha o teste.
    'db/postgres': { db: () => ({ query: async (sql: string, params: unknown[]) => {
        if (!sql.startsWith('UPDATE sessoes_administrativas SET ultima_atividade_em=clock_timestamp() WHERE id=$1')) throw new Error(`SQL inesperado na rota: ${sql}`);
        chamadas.push({ acao: 'atividade', args: params });
        return { rows: [], rowCount: 1 };
    } }) },
    'autenticacao/service': {
        authError,
        consultarSessao: async (token: string) => {
            chamadas.push({ acao: 'consultarSessao', args: [token] });
            if (token !== TOKEN) throw authError();
            return sessao;
        },
        loginAdmin: async (...args: unknown[]) => { chamadas.push({ acao: 'login', args }); return respostaLogin(); },
        logoutAdmin: async (...args: unknown[]) => { chamadas.push({ acao: 'logout', args }); },
        reautenticarAdmin: async (...args: unknown[]) => {
            chamadas.push({ acao: 'reautenticar', args });
            return { token: 'token-renovado', csrf: 'csrf-renovado', expires: EXPIRA, renovacao: { anterior: 'sessao-anterior', atual: 'sessao-nova' } };
        },
    },
    'assinatura/paywall': { exigirAcessoComercial: async () => undefined, resumoComercialDaEmpresa: async () => null },
    'autenticacao/contexto': { contextoDaSessao: async () => ({ empresaAtual: null }) },
    'autenticacao/empresa-ativa': { selecionarEmpresaAtiva: async () => { throw new Error('fora do escopo'); } },
    'assinatura/recursos-plano': { recursoIncluido: async () => false },
    'marketing/capacidades': { menuMarketingVisivel: async () => false },
    'cadastro/publico': { situacaoCadastro: () => ({ aberto: false }) },
    'comercial/pacotes-admin': { PacoteAdminError },
}, cache) as { POST: (r: unknown) => Promise<Response> };

const { NextRequest } = createRequire(import.meta.url)('next/server') as { NextRequest: new (url: string, init?: RequestInit) => unknown };

function pedido(corpo: unknown, opcoes: { csrfCookie?: string | null; csrfCabecalho?: string | null; token?: string | null; origin?: string; extras?: Record<string, string> } = {}) {
    const cookies: string[] = [];
    const csrfCookie = opcoes.csrfCookie === undefined ? CSRF : opcoes.csrfCookie;
    if (csrfCookie) cookies.push(`${COOKIE_CSRF}=${csrfCookie}`);
    if (opcoes.token) cookies.push(`${COOKIE}=${opcoes.token}`);
    const headers: Record<string, string> = { 'content-type': 'application/json', origin: opcoes.origin ?? ORIGEM, 'user-agent': 'teste-rota-autenticacao', ...(opcoes.extras ?? {}) };
    const csrfCabecalho = opcoes.csrfCabecalho === undefined ? CSRF : opcoes.csrfCabecalho;
    if (csrfCabecalho) headers['x-csrf-token'] = csrfCabecalho;
    if (cookies.length) headers.cookie = cookies.join('; ');
    return new NextRequest(URL_ROTA, { method: 'POST', headers, body: JSON.stringify(corpo) });
}
function cookiesDe(res: Response) {
    return (res.headers as Headers & { getSetCookie(): string[] }).getSetCookie();
}

const AMBIENTE = ['ADMIN_AUTH_ORIGIN', 'NODE_ENV', 'RENDER', 'ORIGEM_CLIENTE_BORDA', 'KIDMAIS_DEPLOY_ENV'] as const;
const anterior = Object.fromEntries(AMBIENTE.map((n) => [n, process.env[n]]));
function ambiente(extra: Partial<Record<(typeof AMBIENTE)[number], string>>) {
    for (const n of AMBIENTE) delete (process.env as Record<string, string | undefined>)[n];
    Object.assign(process.env, { ADMIN_AUTH_ORIGIN: ORIGEM, NODE_ENV: 'production' }, extra);
}
test.beforeEach(() => { chamadas.length = 0; respostaLogin = async () => ({ token: 'novo-token', csrf: 'novo-csrf', expires: EXPIRA }); ambiente({}); });
test.after(() => {
    for (const n of AMBIENTE) {
        if (anterior[n] === undefined) delete (process.env as Record<string, string | undefined>)[n];
        else (process.env as Record<string, string | undefined>)[n] = anterior[n];
    }
});

test('login aceito: 200, cookies de sessão e de CSRF HttpOnly, Secure, SameSite=Lax, Path=/ e com o prazo da sessão; sem renovação', async () => {
    const res = await rota.POST(pedido({ acao: 'login', email: 'pessoa@exemplo.test', senha: 'qualquer' }));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await res.json(), { ok: true, data: { csrf: 'novo-csrf', renovacao: null } });
    const set = cookiesDe(res);
    for (const [nome, valor] of [[COOKIE, 'novo-token'], [COOKIE_CSRF, 'novo-csrf']]) {
        const linha = set.find((c) => c.startsWith(`${nome}=`));
        assert.ok(linha, `cookie ${nome}`);
        assert.ok(linha.startsWith(`${nome}=${valor};`), linha);
        for (const atributo of [/;\s*HttpOnly/i, /;\s*Secure/i, /;\s*SameSite=lax/i, /;\s*Path=\//i, /;\s*Expires=Tue, 01 Jan 2030 00:00:00 GMT/i])
            assert.match(linha, atributo, `${nome}: ${linha}`);
    }
    assert.equal(chamadas.length, 1);
    assert.deepEqual(chamadas[0].args.slice(0, 2), ['pessoa@exemplo.test', 'qualquer']);
});

test('CSRF: sem cookie, com cabeçalho diferente ou mal formado → 403, e o login nem é chamado', async () => {
    for (const opcoes of [{ csrfCookie: null }, { csrfCabecalho: 'd'.repeat(43) }, { csrfCookie: 'curto', csrfCabecalho: 'curto' }, { csrfCabecalho: null }]) {
        const res = await rota.POST(pedido({ acao: 'login', email: 'pessoa@exemplo.test', senha: 'x' }, opcoes));
        assert.equal(res.status, 403, JSON.stringify(opcoes));
        assert.equal((await res.json()).erro, 'Verificação CSRF recusada.');
        assert.equal(cookiesDe(res).length, 0);
    }
    assert.equal(chamadas.length, 0);
});

test('origem: outra origem → 403 antes do CSRF e do login', async () => {
    const res = await rota.POST(pedido({ acao: 'login', email: 'pessoa@exemplo.test', senha: 'x' }, { origin: 'https://outro.exemplo.test' }));
    assert.equal(res.status, 403);
    assert.equal(chamadas.length, 0);
});

test('Retry-After: 429 do login com prazo leva o cabeçalho em segundos inteiros; 429 sem prazo e 401 não levam', async () => {
    respostaLogin = async () => { throw authError('Aguarde antes de tentar novamente.', 429, { retryAfterSegundos: 899.2 }); };
    let res = await rota.POST(pedido({ acao: 'login', email: 'pessoa@exemplo.test', senha: 'x' }));
    assert.equal(res.status, 429);
    assert.equal(res.headers.get('retry-after'), '900');
    assert.equal(cookiesDe(res).length, 0, 'nenhuma sessão no 429');
    respostaLogin = async () => { throw authError('Aguarde antes de tentar novamente.', 429); };
    res = await rota.POST(pedido({ acao: 'login', email: 'pessoa@exemplo.test', senha: 'x' }));
    assert.equal(res.status, 429);
    assert.equal(res.headers.get('retry-after'), null);
    respostaLogin = async () => { throw authError(); };
    res = await rota.POST(pedido({ acao: 'login', email: 'pessoa@exemplo.test', senha: 'x' }));
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('retry-after'), null);
});

test('falha inesperada do login vira 500 genérico, sem cookie e sem detalhe na resposta', async () => {
    respostaLogin = async () => { throw new Error('timeout exceeded when trying to connect'); };
    const original = console.error;
    console.error = () => undefined;
    try {
        const res = await rota.POST(pedido({ acao: 'login', email: 'pessoa@exemplo.test', senha: 'x' }));
        assert.equal(res.status, 500);
        assert.deepEqual(await res.json(), { ok: false, erro: 'Falha na autenticação.' });
        assert.equal(cookiesDe(res).length, 0);
    }
    finally {
        console.error = original;
    }
});

test('logout: exige sessão, chama logoutAdmin com o token do cookie e apaga os dois cookies (Max-Age=0)', async () => {
    const res = await rota.POST(pedido({ acao: 'logout' }, { token: TOKEN }));
    assert.equal(res.status, 200);
    assert.deepEqual(chamadas.map((c) => c.acao), ['consultarSessao', 'atividade', 'logout']);
    assert.deepEqual(chamadas[2].args, [TOKEN]);
    const set = cookiesDe(res);
    for (const nome of [COOKIE, COOKIE_CSRF]) {
        const linha = set.find((c) => c.startsWith(`${nome}=`));
        assert.ok(linha && /Max-Age=0/i.test(linha) && linha.startsWith(`${nome}=;`), `${nome}: ${linha}`);
    }
    // Sem sessão válida, o logout não chama o serviço.
    chamadas.length = 0;
    const semSessao = await rota.POST(pedido({ acao: 'logout' }, { token: 'x'.repeat(43) }));
    assert.equal(semSessao.status, 401);
    assert.deepEqual(chamadas.map((c) => c.acao), ['consultarSessao']);
});

test('reautenticação: exige sessão, passa token, senha, IP e user agent, devolve a renovação e troca os cookies', async () => {
    const res = await rota.POST(pedido({ acao: 'reautenticar', senha: 'senha-atual' }, { token: TOKEN }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, data: { csrf: 'csrf-renovado', renovacao: { anterior: 'sessao-anterior', atual: 'sessao-nova' } } });
    const reaut = chamadas.find((c) => c.acao === 'reautenticar');
    assert.deepEqual(reaut?.args, [TOKEN, 'senha-atual', null, 'teste-rota-autenticacao']);
    const set = cookiesDe(res);
    assert.ok(set.some((c) => c.startsWith(`${COOKIE}=token-renovado;`)));
    assert.ok(set.some((c) => c.startsWith(`${COOKIE_CSRF}=csrf-renovado;`)));
});

test('IP entregue ao login: borda desligada → null; borda confirmada → penúltimo XFF conferido com CF-Connecting-IP; forjado → null', async () => {
    const cabecalhos = { 'x-forwarded-for': '177.10.20.30, 45.160.0.66, 104.23.190.11', 'cf-connecting-ip': '45.160.0.66' };
    const avisos: string[] = [];
    const original = console.warn;
    console.warn = (m: string) => { avisos.push(String(m)); };
    try {
        // Como production sai no deploy: RENDER=true e ORIGEM_CLIENTE_BORDA ausente.
        ambiente({ RENDER: 'true' });
        await rota.POST(pedido({ acao: 'login', email: 'pessoa@exemplo.test', senha: 'x' }, { extras: cabecalhos }));
        assert.equal(chamadas.at(-1)?.args[3], null, 'sem a borda confirmada, nenhum IP (nem o último XFF)');
        assert.equal(chamadas.at(-1)?.args[4], 'teste-rota-autenticacao');
        // Depois do G1 aprovado: a flag ligada.
        ambiente({ RENDER: 'true', ORIGEM_CLIENTE_BORDA: 'render-cloudflare-sobrescreve' });
        await rota.POST(pedido({ acao: 'login', email: 'pessoa@exemplo.test', senha: 'x' }, { extras: cabecalhos }));
        assert.equal(chamadas.at(-1)?.args[3], '45.160.0.66', 'o penúltimo, igual ao CF-Connecting-IP');
        // CF-Connecting-IP divergente (cabeçalho forjado): null.
        await rota.POST(pedido({ acao: 'login', email: 'pessoa@exemplo.test', senha: 'x' }, { extras: { ...cabecalhos, 'cf-connecting-ip': '177.10.20.30' } }));
        assert.equal(chamadas.at(-1)?.args[3], null);
    }
    finally {
        console.warn = original;
    }
    assert.ok(avisos.every((m) => !m.includes('177.10.20.30') || m.startsWith('[origem]')), 'só a linha de diagnóstico da origem');
});
