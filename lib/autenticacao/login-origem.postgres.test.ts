import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { conectarDescartavel, encerrarDescartavel, portaDescartavel, senhaRecusada } from '../comercial/postgres-descartavel.ts';
import { carregarModulo } from '../acessos/teste-carregador.ts';
import { chaveDaOrigem, origemConfiavel } from '../http/origem-cliente.ts';

/**
 * Login com limite por ORIGEM (IP confiável, só falhas) e por CONTA, no PostgreSQL DESCARTÁVEL (modelo "atual" da
 * receita; scripts/regressao-v1-selecao.cjs), com pool REAL (10 conexões, espera de 10 s). A prova de que o scrypt
 * não segura conexão é direta: cada login conta, no próprio contexto (AsyncLocalStorage), as transações abertas no
 * instante em que confere a senha — tem de ser 0 (a base dá 1). Nenhum dado real; identidades @exemplo.test.
 * Decisão e números: docs/LOGIN_LIMITE_ORIGEM_POOL_20261022.md.
 */
process.env.ADMIN_AUTH_SECRET = `segredo-sintetico-de-teste-${'x'.repeat(24)}`;

type Login = (email: string, senha: string, requestId: string, ip: string | null, ua: string | null) => Promise<{ token: string }>;
let admin: pg.Client;
let pool: pg.Pool;
let auth: { loginAdmin: Login; REGRA_ORIGEM_LOGIN: { namespace: string; janelaSegundos: number; limite: number }; consumirLimite: (tx: ReturnType<typeof executor>, t: 'IDENTIFICADOR' | 'ORIGEM', v: string, r: { janelaSegundos: number; limite: number }) => Promise<boolean> };
let maxEmUso = 0;
const contexto = new AsyncLocalStorage<{ abertas: number; duranteScrypt: number[] }>();
const duranteScrypt: number[] = [];

function executor(c: pg.Pool | pg.PoolClient) {
    return { query: async (sql: string, params: unknown[] = []) => { const r = await c.query(sql, params as unknown[]); return { rows: r.rows, rowCount: r.rowCount }; } };
}
const emUso = () => pool.totalCount - pool.idleCount;
async function withTransaction<T>(work: (tx: ReturnType<typeof executor>) => Promise<T>): Promise<T> {
    const estado = contexto.getStore();
    const client = await pool.connect();
    maxEmUso = Math.max(maxEmUso, emUso());
    if (estado)
        estado.abertas++;
    try {
        await client.query('BEGIN');
        const r = await work(executor(client));
        await client.query('COMMIT');
        return r;
    }
    catch (error) {
        await client.query('ROLLBACK');
        throw error;
    }
    finally {
        client.release();
        if (estado)
            estado.abertas--;
    }
}

const sufixo = randomBytes(3).toString('hex');
const email = (nome: string) => `login-${nome}-${sufixo}@exemplo.test`;
const SENHA = 'senha-correta-login-2210';
const EMPRESA_IP = '177.10.20.30';      // empresa inteira atrás do mesmo NAT
const OUTRA_IP = '200.150.10.20';       // outra origem independente
const ABUSO_IP = '45.160.0.66';         // quem erra de propósito

async function tentar(conta: string, senha: string, ip: string | null) {
    try {
        await contexto.run({ abertas: 0, duranteScrypt }, () => auth.loginAdmin(conta, senha, randomUUID(), ip, 'teste-login-origem'));
        return 'OK';
    }
    catch (error) {
        const e = error as { httpStatus?: number; message?: string; details?: { retryAfterSegundos?: number } };
        return e.httpStatus ? String(e.httpStatus) : `ERRO ${e.message}`;
    }
}
const contagem = (r: string[]) => r.reduce<Record<string, number>>((a, s) => ({ ...a, [s]: (a[s] ?? 0) + 1 }), {});
const chaveOrigem = (ip: string) => createHmac('sha256', process.env.ADMIN_AUTH_SECRET!).update(`${auth.REGRA_ORIGEM_LOGIN.namespace}|ORIGEM|${chaveDaOrigem(ip)}`).digest('hex');
async function linhaOrigem(ip: string) {
    return (await admin.query<{ tentativas: number; bloqueado: boolean }>('SELECT tentativas, COALESCE(bloqueado_ate > clock_timestamp(), false) AS bloqueado FROM limites_autenticacao WHERE chave_hash=$1', [chaveOrigem(ip)])).rows[0] ?? null;
}
const usuarios: string[] = [];

test.before(async () => {
    admin = await conectarDescartavel();
    const porta = portaDescartavel();
    pool = new pg.Pool({ host: '127.0.0.1', port: porta, user: 'kidmais_descartavel', database: 'kidmais_pacotes_v1_descartavel', password: senhaRecusada, application_name: 'kidmais-login-origem', max: 10, connectionTimeoutMillis: 10_000 });
    const id = (await pool.query<{ db: string; cluster: string; addr: string }>("SELECT current_database() AS db, current_setting('cluster_name') AS cluster, host(inet_server_addr()) AS addr")).rows[0];
    assert.deepEqual(id, { db: 'kidmais_pacotes_v1_descartavel', cluster: 'kidmais_descartavel', addr: '127.0.0.1' });
    const cache = new Map<string, Record<string, unknown>>();
    const senha = carregarModulo('lib/autenticacao/senha.ts', {}, new Map()) as unknown as { criarHashSenha: (s: string) => Promise<string>; conferirSenha: (s: string, h: string | null) => Promise<boolean>; hashToken: (v: string) => string };
    // Dublê fino de senha.ts: o scrypt é o real; só registra quantas transações DESTE login estão abertas ao conferir.
    const conferirSenha = async (s: string, h: string | null) => {
        duranteScrypt.push(contexto.getStore()?.abertas ?? -1);
        return senha.conferirSenha(s, h);
    };
    auth = carregarModulo('lib/autenticacao/service.ts', { 'db/postgres': { db: () => executor(pool), withTransaction }, 'autenticacao/senha': { ...senha, conferirSenha } }, cache) as unknown as typeof auth;
    const hash = await senha.criarHashSenha(SENHA);
    for (let i = 0; i < 55; i++)
        usuarios.push((await admin.query<{ email: string }>("INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel) VALUES ($1, $2, $3, 'REPRESENTANTE_AUTORIZADO') RETURNING email", [email(`p${i}`), `Pessoa ${i}`, hash])).rows[0].email);
});

test.after(async () => {
    await pool?.end();
    if (admin)
        await encerrarDescartavel(admin);
});

test('50 logins simultâneos do MESMO IP com a senha certa: nenhum 429, nenhuma conexão presa durante o scrypt', async () => {
    maxEmUso = 0;
    duranteScrypt.length = 0;
    const inicio = Date.now();
    const r = await Promise.all(usuarios.slice(0, 50).map((u) => tentar(u, SENHA, EMPRESA_IP)));
    const ms = Date.now() - inicio;
    assert.deepEqual(contagem(r), { OK: 50 }, JSON.stringify(contagem(r)));
    // Sucesso não consome a origem: a reserva foi devolvida em todos.
    assert.deepEqual(await linhaOrigem(EMPRESA_IP), { tentativas: 0, bloqueado: false });
    assert.equal(duranteScrypt.length, 50);
    assert.deepEqual([...new Set(duranteScrypt)], [0], `transações abertas durante o scrypt: ${JSON.stringify(contagem(duranteScrypt.map(String)))}`);
    console.log(`[evidência] 50 logins em ${ms} ms com pool max 10 / espera 10 s; pico de conexões em uso ${maxEmUso}; transações abertas no scrypt: ${JSON.stringify(contagem(duranteScrypt.map(String)))}`);
    // E a rajada se repete (sem acumular nada): mais 50 seguidos, ainda sem 429.
    const r2 = await Promise.all(usuarios.slice(0, 50).map((u) => tentar(u, SENHA, EMPRESA_IP)));
    assert.deepEqual(contagem(r2), { OK: 50 });
});

test('duas origens independentes: as falhas de uma não aparecem na outra', async () => {
    const r = await Promise.all([
        ...Array.from({ length: 6 }, (_, i) => tentar(email(`inexistente-a${i}`), 'errada', EMPRESA_IP)),
        ...Array.from({ length: 3 }, (_, i) => tentar(email(`inexistente-b${i}`), 'errada', OUTRA_IP)),
    ]);
    assert.deepEqual(contagem(r), { 401: 9 });
    assert.deepEqual(await linhaOrigem(EMPRESA_IP), { tentativas: 6, bloqueado: false });
    assert.deepEqual(await linhaOrigem(OUTRA_IP), { tentativas: 3, bloqueado: false });
    // Login certo no meio não muda as contagens.
    assert.equal(await tentar(usuarios[50], SENHA, OUTRA_IP), 'OK');
    assert.deepEqual(await linhaOrigem(OUTRA_IP), { tentativas: 3, bloqueado: false });
});

test('IP abusivo: teto exato sob rajada, bloqueio só dele; a empresa (mesmas contas) e outro IP seguem entrando', async () => {
    const limite = auth.REGRA_ORIGEM_LOGIN.limite;
    // Contador semeado perto do teto (o teto é alto: 300 falhas reais custariam 300 scrypts) e 20 falhas SIMULTÂNEAS
    // com o cabeçalho forjado para parecer a empresa: a origem confiável é o último valor, do proxy.
    await admin.query("UPDATE limites_autenticacao SET tentativas=0, bloqueado_ate=NULL, janela_iniciada_em=now() WHERE chave_hash=$1", [chaveOrigem(ABUSO_IP)]);
    await admin.query("INSERT INTO limites_autenticacao (chave_hash, tipo, tentativas, janela_iniciada_em) VALUES ($1, 'ORIGEM', $2, now()) ON CONFLICT (chave_hash) DO UPDATE SET tentativas=$2, janela_iniciada_em=now(), bloqueado_ate=NULL", [chaveOrigem(ABUSO_IP), limite - 5]);
    const forjado = { headers: { get: (n: string) => (n === 'x-forwarded-for' ? `${EMPRESA_IP}, ${ABUSO_IP}` : n === 'true-client-ip' ? EMPRESA_IP : null) } };
    const ipDoAbuso = origemConfiavel(forjado, { RENDER: 'true' });
    assert.equal(ipDoAbuso, ABUSO_IP, 'o cabeçalho forjado não escolhe a chave');
    // Contas da própria empresa como alvo (uma tentativa por conta, abaixo do limite de 5 por conta).
    const r = await Promise.all(usuarios.slice(0, 20).map((u) => tentar(u, 'senha-errada', ipDoAbuso)));
    assert.deepEqual(contagem(r), { 401: 5, 429: 15 }, `exatamente o que cabia no teto: ${JSON.stringify(contagem(r))}`);
    assert.deepEqual(await linhaOrigem(ABUSO_IP), { tentativas: limite, bloqueado: true });
    // Bloqueado: nem a senha certa entra por ESTE IP, e o 429 traz prazo.
    let detalhes: { retryAfterSegundos?: number } | undefined;
    await auth.loginAdmin(usuarios[0], SENHA, randomUUID(), ABUSO_IP, null).catch((e: { httpStatus: number; details?: { retryAfterSegundos?: number } }) => {
        assert.equal(e.httpStatus, 429);
        detalhes = e.details;
    });
    assert.ok(detalhes?.retryAfterSegundos && detalhes.retryAfterSegundos > 800);
    // A empresa (as MESMAS contas atacadas) entra pelo IP dela; outra origem também.
    const empresa = await Promise.all(usuarios.slice(0, 20).map((u) => tentar(u, SENHA, EMPRESA_IP)));
    assert.deepEqual(contagem(empresa), { OK: 20 });
    assert.equal(await tentar(usuarios[51], SENHA, OUTRA_IP), 'OK');
    assert.deepEqual(await linhaOrigem(EMPRESA_IP), { tentativas: 6, bloqueado: false });
});

test('sem IP confiável: nenhuma chave global; 40 falhas de qualquer um não trancam os outros; o limite por conta continua', async () => {
    const antes = Number((await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM limites_autenticacao WHERE tipo='ORIGEM'")).rows[0].n);
    const falhas = await Promise.all(Array.from({ length: 40 }, (_, i) => tentar(email(`sem-ip-${i}`), 'errada', null)));
    assert.deepEqual(contagem(falhas), { 401: 40 });
    const certos = await Promise.all(usuarios.slice(0, 50).map((u) => tentar(u, SENHA, null)));
    assert.deepEqual(contagem(certos), { OK: 50 }, 'nada de 429 global');
    assert.equal(Number((await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM limites_autenticacao WHERE tipo='ORIGEM'")).rows[0].n), antes, 'nenhuma linha de origem criada');
    // Conta: 5 falhas e a 6ª tentativa, mesmo com a senha certa, recebe 429 (proteção por conta preservada).
    const alvo = usuarios[52];
    for (let i = 0; i < 5; i++)
        assert.equal(await tentar(alvo, 'errada', null), '401');
    assert.equal(await tentar(alvo, SENHA, null), '429');
    // As outras contas seguem.
    assert.equal(await tentar(usuarios[53], SENHA, null), 'OK');
});

test('janela nova sob concorrência (IP novo e conta nova): nenhuma violação da CHECK de datas, contagem exata', async () => {
    // Transação mais antiga travando depois de uma mais nova abrir a janela: sem LEAST, atualizado_em < janela → 500.
    for (let rodada = 0; rodada < 3; rodada++) {
        const ip = `187.40.${rodada}.9`;
        const r = await Promise.all(Array.from({ length: 25 }, (_, i) => tentar(email(`janela-${rodada}-${i}`), 'errada', ip)));
        assert.deepEqual(contagem(r), { 401: 25 }, JSON.stringify(contagem(r)));
        assert.deepEqual(await linhaOrigem(ip), { tentativas: 25, bloqueado: false });
        const conta = email(`conta-nova-${rodada}`);
        const c = await Promise.all(Array.from({ length: 8 }, () => tentar(conta, 'errada', `187.41.${rodada}.9`)));
        assert.deepEqual(contagem(c), { 401: 5, 429: 3 }, `limite por conta exato: ${JSON.stringify(contagem(c))}`);
    }
});

test('determinístico: transação que começou ANTES de outra abrir a janela consegue consumir (sem 500 da CHECK)', async () => {
    const antiga = await pool.connect();
    try {
        await antiga.query('BEGIN');
        await antiga.query('SELECT now()'); // fixa o now() desta transação antes da janela existir
        await new Promise((fim) => setTimeout(fim, 20));
        const conta = email('janela-deterministica');
        assert.equal(await tentar(conta, 'errada', null), '401'); // outra transação abre a janela da conta e confirma
        assert.equal(await auth.consumirLimite(executor(antiga), 'IDENTIFICADOR', conta, { janelaSegundos: 900, limite: 5 }), true);
        await antiga.query('COMMIT');
    }
    finally {
        await antiga.query('ROLLBACK').catch(() => undefined);
        antiga.release();
    }
});

test('o limite por conta vale por IP também: 5 falhas em uma conta não afetam o IP nem as colegas', async () => {
    const alvo = usuarios[54];
    for (let i = 0; i < 5; i++)
        assert.equal(await tentar(alvo, 'errada', OUTRA_IP), '401');
    assert.equal(await tentar(alvo, SENHA, OUTRA_IP), '429');
    assert.equal(await tentar(usuarios[50], SENHA, OUTRA_IP), 'OK');
    assert.deepEqual(await linhaOrigem(OUTRA_IP), { tentativas: 8, bloqueado: false }, '3 + 5 falhas reais; o 429 da conta devolve a vaga');
});
