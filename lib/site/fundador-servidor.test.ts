import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { carregarModulo } from '../acessos/teste-carregador.ts';

/** O site nunca espera o banco além do limite: demora ou falha viram texto neutro (null). */
type Tx = { query: (sql: string) => Promise<{ rows: object[] }> };
const carregar = (withTransaction: (t: (tx: Tx) => Promise<unknown>) => Promise<unknown>) =>
    carregarModulo('lib/site/fundador-servidor.ts', { 'lib/db/postgres': { withTransaction } }, new Map()) as {
        resumoCampanhaSite: (limiteMs?: number) => Promise<unknown>; proximaMudanca: (r: object) => number };

test('banco lento: devolve null no limite, sem esperar a consulta', async () => {
    const { resumoCampanhaSite } = carregar(() => new Promise(() => {}));
    const inicio = Date.now();
    assert.equal(await resumoCampanhaSite(50), null);
    assert.ok(Date.now() - inicio < 1000);
});

test('falha de leitura vira null; leitura normal limita a consulta e devolve o resumo', async () => {
    assert.equal(await carregar(async () => { throw new Error('sem banco'); }).resumoCampanhaSite(50), null);
    const sqls: string[] = [];
    const tx: Tx = { query: async (sql) => { sqls.push(sql); return { rows: sql.includes('AS instalado090') ? [{ instalado090: false }] : [] }; } };
    assert.deepEqual(await carregar((t) => t(tx)).resumoCampanhaSite(1000), { fase: 'LEGADO' });
    assert.match(sqls[0]!, /SET LOCAL statement_timeout = '2s'/);
});

test('uma leitura em andamento por vez; resultado guardado por instantes; falha não é guardada', async () => {
    let chamadas = 0;
    let liberar: () => void = () => {};
    const tx: Tx = { query: async (sql) => ({ rows: sql.includes('AS instalado090') ? [{ instalado090: false }] : [] }) };
    const { resumoCampanhaSite } = carregar(async (t) => { chamadas++; await new Promise<void>((ok) => { liberar = ok; }); return t(tx); });
    const duas = Promise.all([resumoCampanhaSite(1000), resumoCampanhaSite(1000)]);
    await new Promise((r) => setTimeout(r, 10));
    liberar();
    assert.deepEqual(await duas, [{ fase: 'LEGADO' }, { fase: 'LEGADO' }]);
    assert.equal(chamadas, 1, 'duas visitas simultâneas, uma transação');
    assert.deepEqual(await resumoCampanhaSite(1000), { fase: 'LEGADO' });
    assert.equal(chamadas, 1, 'dentro do cache não consulta de novo');
    let falhas = 0;
    const falho = carregar(async () => { falhas++; throw new Error('sem banco'); });
    assert.equal(await falho.resumoCampanhaSite(100), null);
    assert.equal(await falho.resumoCampanhaSite(100), null);
    assert.equal(falhas, 2, 'falha não fica guardada');
});

test('P3-1: cache não atravessa a mudança de fase (abertura ou fim da janela); sem fronteira, só o prazo curto', async () => {
    const { proximaMudanca } = carregar(async () => null);
    const fim = '2026-12-01T03:00:00.000Z', inicio = '2026-11-01T03:00:00.000Z';
    assert.equal(proximaMudanca({ fase: 'JANELA', prazo: {}, janelaFim: fim }), Date.parse(fim));
    assert.equal(proximaMudanca({ fase: 'ANTES', inicio }), Date.parse(inicio));
    for (const r of [{ fase: 'LEGADO' }, { fase: 'DESLIGADA' }, { fase: 'ENCERRADA' }, { fase: 'POS_JANELA', vagasRestantes: 1, emConfirmacao: 0, limite: 20 }, { fase: 'JANELA', prazo: {} }])
        assert.equal(proximaMudanca(r), Infinity, JSON.stringify(r));
    // Relógio controlado (só Date; P3-N1): a carga do módulo não entra no critério. Fronteira a 10 s, antes dos 30 s do cache.
    const tx: Tx = { query: async (sql) => ({ rows: sql.includes('AS instalado090') ? [{ instalado090: true }] : [] }) };
    for (const [fase, resumo] of [
        ['JANELA', (t: string) => ({ fase: 'JANELA', prazo: { dia: '30/11/2026', hora: '23h59', texto: 'x' }, janelaFim: t })],
        ['ANTES', (t: string) => ({ fase: 'ANTES', inicio: t })],
    ] as const) {
        mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-30T12:00:00.000Z') });
        try {
            let chamadas = 0;
            const fronteira = new Date(Date.now() + 10_000).toISOString();
            const site = carregarModulo('lib/site/fundador-servidor.ts', {
                'lib/db/postgres': { withTransaction: async (w: (t: Tx) => Promise<unknown>) => { chamadas++; return w(tx); } },
                'assinatura/campanha': { resumoCampanha: async () => resumo(fronteira) },
            }, new Map()) as { resumoCampanhaSite: (l?: number) => Promise<unknown> };
            await site.resumoCampanhaSite(1000);
            mock.timers.tick(9_999);
            await site.resumoCampanhaSite(1000);
            assert.equal(chamadas, 1, `${fase}: 1 ms antes da fronteira, cache`);
            mock.timers.tick(1);
            await site.resumoCampanhaSite(1000);
            assert.equal(chamadas, 2, `${fase}: na fronteira, nova leitura (não espera os 30 s)`);
        }
        finally { mock.timers.reset(); }
    }
});
