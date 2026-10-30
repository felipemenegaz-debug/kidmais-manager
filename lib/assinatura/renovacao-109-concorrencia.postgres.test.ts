import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Client } from 'pg';
import { conectarDescartavel, encerrarDescartavel } from '../comercial/postgres-descartavel.ts';
import { travaPorEmpresa } from './cobranca.ts';
import { repositorioRenovacao, substituirRenovacao } from './renovacao-repositorio.ts';
import { capacidadeRenovacao } from './renovacao-schema.ts';
import type { RegistroRenovacao } from './renovacao-fundador.ts';
import { empresaFundador, hojeBanco, inserir, mensagem, somar, usuarioSintetico } from './renovacao-109-apoio.postgres.test-apoio.ts';

const usuarioGestao = async (c: Client) => (await c.query("INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Gestão 109', $2, 'REPRESENTANTE_AUTORIZADO', true) RETURNING id",
    usuarioSintetico())).rows[0].id as string;

/**
 * B-9 production — concorrência em DUAS conexões reais (plano rev. 5 §2.6/§4, R3-F2/R4-F2), modelo 109. Três provas distintas,
 * com a trava real: (1) operacional — travaPorEmpresa (pg_try_advisory_xact_lock) RECUSA sem esperar; (2) repositório — a trava
 * de linha da empresa ESPERA (observada em pg_stat_activity) e as duas chamadas devolvem o mesmo vigente; (3) sem serialização —
 * INSERTs diretos nas ordens (a) e (b), na 109 e na 075. E substituir × substituir e substituir × envio nas duas ordens.
 */
const opt = () => process.env.KIDMAIS_POSTGRES_DESCARTAVEL === 'kidmais_pacotes_v1_descartavel';
let a: Client, b: Client;
let usuario = '', hoje = '';
const ler = (r: string) => readFileSync(new URL(`../../${r}`, import.meta.url), 'utf8');
const pidDe = async (c: Client) => (await c.query('SELECT pg_backend_pid() AS p')).rows[0].p as number;
/** Espera observada: a conexão `pid` fica bloqueada num lock (wait_event_type = 'Lock'). */
async function esperandoLock(pid: number) {
    for (let i = 0; i < 200; i++) {
        const r = (await a.query('SELECT wait_event_type AS t FROM pg_stat_activity WHERE pid = $1', [pid])).rows[0];
        if (r?.t === 'Lock') return true;
        await new Promise((x) => setTimeout(x, 25));
    }
    return false;
}
const comTx = (c: Client) => async <T>(f: (tx: never) => Promise<T>) => {
    await c.query('BEGIN');
    try { const r = await f(c as never); await c.query('COMMIT'); return r; } catch (e) { await c.query('ROLLBACK'); throw e; }
};
const linhas = async (contratacao: string) => (await a.query('SELECT id, estado, substitui_id FROM assinatura_renovacoes WHERE contratacao_id = $1 ORDER BY criado_em', [contratacao])).rows;
function registroDe(e: { empresaId: string; contratacaoId: string }, id: string, pdr: string, pv: string): RegistroRenovacao {
    return { id, empresaId: e.empresaId, contratacaoId: e.contratacaoId, destinatarioId: usuario, primeiroVencimento: pv, primeiraDataRegular: pdr,
        mensagem: mensagem(id), estado: 'PENDENTE', avisoTentadoEm: null, avisoEnviadoEm: null, precoAplicadoEm: null, ultimoErro: null };
}

test.before(async () => {
    if (!opt()) return;
    a = await conectarDescartavel();
    b = await conectarDescartavel({ travar: false });
    usuario = await usuarioGestao(a);
    hoje = await hojeBanco(a);
});
test.after(async () => { if (b) await b.end(); if (a) await encerrarDescartavel(a); });

test('0. sem serialização na 075 (antes de qualquer histórico: down real, depois a 109 de novo): (a) e (b) arbitradas pela unicidade integral', { skip: !opt() }, async () => {
    await a.query(ler('database/rollback/20261029_109_renovacao_substituta_down.sql'));
    try {
        assert.deepEqual(await capacidadeRenovacao(a as never), { capacidade: '075' });
        const e = await empresaFundador(a, usuario);
        const ins = (c: Client, id: string) => c.query(`INSERT INTO assinatura_renovacoes (id,empresa_id,contratacao_id,destinatario_id,primeiro_vencimento,primeira_data_regular,aviso_dias,mensagem)
            VALUES ($1::uuid,$2,$3,$4,$5,$6,30,$7) ON CONFLICT DO NOTHING`, [id, e.empresaId, e.contratacaoId, usuario, somar(hoje, -300), somar(hoje, 60), JSON.stringify(mensagem(id))]);
        // (b) na 075: primeiro COMMIT antes do INSERT da segunda → a UNIQUE integral arbitra, sem exceção.
        await ins(a, 'd1d1d1d1-d1d1-41d1-81d1-d1d1d1d1d1d1');
        assert.equal((await ins(b, 'e1e1e1e1-e1e1-41e1-81e1-e1e1e1e1e1e1')).rowCount, 0);
        // (a) na 075 (outra contratação): a segunda espera e é absorvida.
        const e2 = await empresaFundador(a, usuario);
        const ins2 = (c: Client, id: string) => c.query(`INSERT INTO assinatura_renovacoes (id,empresa_id,contratacao_id,destinatario_id,primeiro_vencimento,primeira_data_regular,aviso_dias,mensagem)
            VALUES ($1::uuid,$2,$3,$4,$5,$6,30,$7) ON CONFLICT DO NOTHING`, [id, e2.empresaId, e2.contratacaoId, usuario, somar(hoje, -300), somar(hoje, 60), JSON.stringify(mensagem(id))]);
        await a.query('BEGIN');
        await ins2(a, 'f1f1f1f1-f1f1-41f1-81f1-f1f1f1f1f1f1');
        const pidB = await pidDe(b);
        const pb = ins2(b, 'f2f2f2f2-f2f2-41f2-81f2-f2f2f2f2f2f2');
        assert.ok(await esperandoLock(pidB));
        await a.query('COMMIT');
        assert.equal((await pb).rowCount, 0);
        assert.equal((await a.query('SELECT count(*)::int AS n FROM assinatura_renovacoes WHERE contratacao_id = ANY($1::uuid[])', [[e.contratacaoId, e2.contratacaoId]])).rows[0].n, 2);
    } finally {
        await a.query(ler('database/checks/20261029_109_precheck.sql'));
        await a.query(ler('database/migrations/20261029_109_renovacao_substituta.sql'));
        await a.query(ler('database/checks/20261029_109_postcheck.sql'));
    }
    assert.deepEqual(await capacidadeRenovacao(a as never), { capacidade: '109' });
});

test('1. operacional: com a trava advisory ocupada, o concorrente é RECUSADO sem esperar (CONTRATACAO_EM_ANDAMENTO)', { skip: !opt() }, async () => {
    const e = await empresaFundador(a, usuario);
    let soltar!: () => void;
    const segurando = new Promise<void>((r) => { soltar = r; });
    let dentro!: () => void;
    const entrou = new Promise<void>((r) => { dentro = r; });
    const primeiro = travaPorEmpresa(comTx(a))(e.empresaId, async () => { dentro(); await segurando; return 'A'; });
    await entrou;
    const inicio = Date.now();
    await assert.rejects(travaPorEmpresa(comTx(b))(e.empresaId, async () => 'B'), (x: Error & { codigo?: string }) => /CONTRATACAO_EM_ANDAMENTO|contratação desta empresa/.test(`${x.codigo ?? ''} ${x.message}`));
    assert.ok(Date.now() - inicio < 2000, 'sem espera');
    soltar(); assert.equal(await primeiro, 'A');
    assert.equal(await travaPorEmpresa(comTx(b))(e.empresaId, async () => 'B'), 'B', 'na rodada seguinte, livre');
});

test('2. repositório: duas chamadas diretas a criar — a segunda ESPERA na trava de linha e devolve o mesmo vigente', { skip: !opt() }, async () => {
    const e = await empresaFundador(a, usuario);
    let soltar!: () => void;
    const segurando = new Promise<void>((r) => { soltar = r; });
    // Conexão A dentro de criar, depois do INSERT e antes do COMMIT.
    const txA = async <T>(f: (tx: never) => Promise<T>) => comTx(a)(async () => {
        const espia = { query: async (sql: string, p?: unknown[]) => { const r = await a.query(sql, p); if (/^INSERT INTO assinatura_renovacoes/.test(sql.trim())) await segurando; return r; } };
        return f(espia as never);
    });
    const rA = repositorioRenovacao(txA, { capacidade: '109' }).criar(registroDe(e, '21212121-2121-4121-8121-212121212121', somar(hoje, 60), somar(hoje, -300)));
    await new Promise((x) => setTimeout(x, 200));
    const pidB = await pidDe(b);
    const rB = repositorioRenovacao(comTx(b), { capacidade: '109' }).criar(registroDe(e, '31313131-3131-4131-8131-313131313131', somar(hoje, 60), somar(hoje, -300)));
    assert.ok(await esperandoLock(pidB), 'espera observada na trava de linha');
    soltar();
    const [x, y] = await Promise.all([rA, rB]);
    assert.deepEqual([x.id, y.id], ['21212121-2121-4121-8121-212121212121', '21212121-2121-4121-8121-212121212121']);
    assert.equal((await linhas(e.contratacaoId)).length, 1);
});

test('3. sem serialização (109): ordem (a) a unicidade arbitra e o DO NOTHING absorve; ordem (b) a guarda recusa a raiz paralela', { skip: !opt() }, async () => {
    const e = await empresaFundador(a, usuario);
    const ins = (c: Client, id: string) => c.query(`INSERT INTO assinatura_renovacoes (id,empresa_id,contratacao_id,destinatario_id,primeiro_vencimento,primeira_data_regular,aviso_dias,mensagem)
        VALUES ($1::uuid,$2,$3,$4,$5,$6,30,$7) ON CONFLICT DO NOTHING`, [id, e.empresaId, e.contratacaoId, usuario, somar(hoje, -300), somar(hoje, 60), JSON.stringify(mensagem(id))]);
    // (a): as duas guardas antes do primeiro COMMIT.
    await a.query('BEGIN'); await b.query('BEGIN');
    await ins(a, '41414141-4141-4141-8141-414141414141');
    const pidB = await pidDe(b);
    const pb = ins(b, '51515151-5151-4151-8151-515151515151');
    assert.ok(await esperandoLock(pidB), '(a) a segunda espera no índice único');
    await a.query('COMMIT');
    assert.equal((await pb).rowCount, 0, '(a) DO NOTHING absorve');
    await b.query('COMMIT');
    assert.equal((await linhas(e.contratacaoId)).length, 1);
    // (b): o primeiro COMMIT antes da guarda da segunda (contratação nova).
    const e2 = await empresaFundador(a, usuario);
    const ins2 = (c: Client, id: string) => c.query(`INSERT INTO assinatura_renovacoes (id,empresa_id,contratacao_id,destinatario_id,primeiro_vencimento,primeira_data_regular,aviso_dias,mensagem)
        VALUES ($1::uuid,$2,$3,$4,$5,$6,30,$7) ON CONFLICT DO NOTHING`, [id, e2.empresaId, e2.contratacaoId, usuario, somar(hoje, -300), somar(hoje, 60), JSON.stringify(mensagem(id))]);
    await ins2(a, '61616161-6161-4161-8161-616161616161');
    await assert.rejects(ins2(b, '71717171-7171-4171-8171-717171717171'), /raiz paralela recusada/, '(b) recusa do perdedor aceita');
    assert.equal((await linhas(e2.contratacaoId)).length, 1);
});

test('4. substituir × substituir: o segundo espera e é recusado (rowCount 0); um sucessor, nenhum órfão', { skip: !opt() }, async () => {
    const e = await empresaFundador(a, usuario);
    const raiz = await inserir(a, e, { pdr: somar(hoje, 10), pv: somar(hoje, -355) });
    const ant = registroDe(e, raiz, somar(hoje, 10), somar(hoje, -355));
    await a.query('BEGIN');
    await substituirRenovacao(a as never, e.empresaId, ant, registroDe(e, '81818181-8181-4181-8181-818181818181', somar(hoje, 40), somar(hoje, -355)));
    const pidB = await pidDe(b);
    const pb = comTx(b)((tx) => substituirRenovacao(tx, e.empresaId, ant, registroDe(e, '91919191-9191-4191-8191-919191919191', somar(hoje, 45), somar(hoje, -355)))).then(() => 'OK', (x: Error) => x.message);
    assert.ok(await esperandoLock(pidB));
    await a.query('COMMIT');
    assert.equal(await pb, 'SUBSTITUICAO_RECUSADA');
    assert.deepEqual((await linhas(e.contratacaoId)).map((l) => l.estado), ['SUBSTITUIDA', 'PENDENTE']);
});

test('5. substituir × envio, nas duas ordens: envio primeiro impede a substituição; substituição primeiro impede o envio pelo predecessor', { skip: !opt() }, async () => {
    // Envio primeiro: a intenção AVISANDO (com tentativa) é commitada; a substituição relê e é recusada.
    const e = await empresaFundador(a, usuario);
    const raiz = await inserir(a, e, { pdr: somar(hoje, 10), pv: somar(hoje, -355) });
    const repoA = repositorioRenovacao(comTx(a), { capacidade: '109' });
    await repoA.marcar(e.empresaId, raiz, { estado: 'AVISANDO', tentativa: true });
    const r1 = await comTx(b)((tx) => substituirRenovacao(tx, e.empresaId, registroDe(e, raiz, somar(hoje, 10), somar(hoje, -355)),
        registroDe(e, 'a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1', somar(hoje, 40), somar(hoje, -355)))).then(() => 'OK', (x: Error) => x.message);
    assert.equal(r1, 'SUBSTITUICAO_RECUSADA');
    assert.deepEqual((await linhas(e.contratacaoId)).map((l) => l.estado), ['AVISANDO']);
    // Substituição primeiro (não commitada): a intenção de envio sobre o predecessor espera e, depois do COMMIT, é recusada.
    const e2 = await empresaFundador(a, usuario);
    const raiz2 = await inserir(a, e2, { pdr: somar(hoje, 10), pv: somar(hoje, -355) });
    await a.query('BEGIN');
    await substituirRenovacao(a as never, e2.empresaId, registroDe(e2, raiz2, somar(hoje, 10), somar(hoje, -355)),
        registroDe(e2, 'b1b1b1b1-b1b1-41b1-81b1-b1b1b1b1b1b1', somar(hoje, 40), somar(hoje, -355)));
    const pidB = await pidDe(b);
    const pb = repositorioRenovacao(comTx(b), { capacidade: '109' }).marcar(e2.empresaId, raiz2, { estado: 'AVISANDO', tentativa: true }).then(() => 'OK', (x: Error) => x.message);
    assert.ok(await esperandoLock(pidB));
    await a.query('COMMIT');
    assert.match(await pb, /terminal/);
    assert.deepEqual((await linhas(e2.contratacaoId)).map((l) => l.estado), ['SUBSTITUIDA', 'PENDENTE'], 'o envio só pode sair pelo sucessor');
});

test('6. F2: envio primeiro COM concorrência — a intenção AVISANDO aberta faz a substituição esperar e, depois do COMMIT, ser recusada', { skip: !opt() }, async () => {
    const e = await empresaFundador(a, usuario);
    const raiz = await inserir(a, e, { pdr: somar(hoje, 10), pv: somar(hoje, -355) });
    // A: mesma forma de marcar (trava de linha da empresa + UPDATE da intenção com tentativa), ainda sem COMMIT.
    await a.query('BEGIN');
    await a.query('SELECT id FROM empresas WHERE id = $1::uuid FOR UPDATE', [e.empresaId]);
    await a.query("UPDATE assinatura_renovacoes SET estado = 'AVISANDO', aviso_tentado_em = clock_timestamp() WHERE id = $1", [raiz]);
    const pidB = await pidDe(b);
    const pb = comTx(b)((tx) => substituirRenovacao(tx, e.empresaId, registroDe(e, raiz, somar(hoje, 10), somar(hoje, -355)),
        registroDe(e, 'a6a6a6a6-a6a6-46a6-86a6-a6a6a6a6a6a6', somar(hoje, 40), somar(hoje, -355)))).then(() => 'OK', (x: Error) => x.message);
    assert.ok(await esperandoLock(pidB), 'a substituição espera a intenção de envio');
    await a.query('COMMIT');
    assert.equal(await pb, 'SUBSTITUICAO_RECUSADA');
    assert.deepEqual((await linhas(e.contratacaoId)).map((l) => l.estado), ['AVISANDO']);
});

test('7. F2: webhook (registrarFalhaEntrega real) × processamento, nas duas ordens; evento antigo sem efeito no sucessor', { skip: !opt() }, async () => {
    const { registrarFalhaEntrega } = await import('./renovacao-entrega.ts');
    const e = await empresaFundador(a, usuario);
    const raiz = await inserir(a, e, { pdr: somar(hoje, 10), pv: somar(hoje, -355) });
    const suc = await comTx(a)((tx) => substituirRenovacao(tx, e.empresaId, registroDe(e, raiz, somar(hoje, 10), somar(hoje, -355)),
        registroDe(e, 'a7a7a7a7-a7a7-47a7-87a7-a7a7a7a7a7a7', somar(hoje, 40), somar(hoje, -355))));
    const repoA = repositorioRenovacao(comTx(a), { capacidade: '109' });
    await repoA.marcar(e.empresaId, suc.id, { estado: 'AVISANDO', tentativa: true });
    await repoA.marcar(e.empresaId, suc.id, { estado: 'AVISADA', envioId: 'email_sucessor_a7' });
    const evento = (id: string) => ({ idExterno: id, motivo: 'ENTREGA_RECUSADA', eventoId: `evt_${id}` });
    // Evento antigo/desconhecido (o predecessor nunca teve id externo): sem efeito.
    assert.equal(await comTx(b)((tx) => registrarFalhaEntrega(tx, evento('email_que_nao_existe'))), 'DESCONHECIDO');
    // Processamento primeiro (trava da empresa segura em A): o webhook não espera e devolve OCUPADO.
    let soltar!: () => void; const segurando = new Promise<void>((r) => { soltar = r; });
    let dentro!: () => void; const entrou = new Promise<void>((r) => { dentro = r; });
    const proc = travaPorEmpresa(comTx(a))(e.empresaId, async () => { dentro(); await segurando; return 'A'; });
    await entrou;
    const inicio = Date.now();
    assert.equal(await comTx(b)((tx) => registrarFalhaEntrega(tx, evento('email_sucessor_a7'))), 'OCUPADO');
    assert.ok(Date.now() - inicio < 2000, 'sem espera');
    soltar(); await proc;
    assert.deepEqual((await linhas(e.contratacaoId)).map((l) => l.estado), ['SUBSTITUIDA', 'AVISADA']);
    // Webhook primeiro (transação de A aberta com a trava): o processamento é recusado sem esperar; depois do COMMIT, só o
    // sucessor vai a REVISAO.
    await a.query('BEGIN');
    assert.equal(await registrarFalhaEntrega(a as never, evento('email_sucessor_a7')), 'REVISAO_REGISTRADA');
    const inicio2 = Date.now();
    await assert.rejects(travaPorEmpresa(comTx(b))(e.empresaId, async () => 'B'), (x: Error & { codigo?: string }) => /CONTRATACAO_EM_ANDAMENTO|contratação desta empresa/.test(`${x.codigo ?? ''} ${x.message}`));
    assert.ok(Date.now() - inicio2 < 2000, 'sem espera');
    await a.query('COMMIT');
    assert.deepEqual((await linhas(e.contratacaoId)).map((l) => l.estado), ['SUBSTITUIDA', 'REVISAO']);
    assert.equal(await comTx(b)((tx) => registrarFalhaEntrega(tx, evento('email_sucessor_a7'))), 'JA_EM_REVISAO');
});
