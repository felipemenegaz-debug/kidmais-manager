import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

/** Guarda de alvo da reconciliação (scripts/assinatura-reconciliar.cjs), sem conectar em banco nenhum. */
const req = createRequire(import.meta.url);
const { validarAlvo, argumentos, provedorDaExecucao, transacaoIndependenteDaExecucao } = req('../../scripts/assinatura-reconciliar.cjs') as {
    transacaoIndependenteDaExecucao: (aplicar: boolean, principal: unknown, abrir: unknown, comPrazo?: unknown, prazoMs?: number) => (trabalho: (tx: unknown) => Promise<unknown>) => Promise<unknown>;
    provedorDaExecucao: (p: Record<string, unknown>, aplicar: boolean, relatorio: Record<string, unknown>) => Record<string, (id?: string) => Promise<unknown>>;
    validarAlvo: (env: Record<string, string | undefined>) => { database: string; host: string; port: number; local: boolean };
    argumentos: (argv: string[]) => { aplicar: boolean };
};
const url = (db: string, host = '127.0.0.1', porta = '55532') => `postgresql://u:senha-sintetica@${host}:${porta}/${db}`;

test('reconciliação: marcador de exclusão em transação independente — aplicando, conexão nova com prazo (BEGIN/COMMIT, liberada); simulando, SAVEPOINT da principal', async () => {
    const { transacaoComPrazo } = await import('../db/transacao-com-prazo.ts');
    const log: string[] = [];
    const principal = { query: async (sql: string) => { log.push(`principal: ${sql}`); return { rows: [] }; } };
    const abrir = async () => ({
        query: async (sql: string) => { log.push(`marcador: ${sql}`); return { rows: [], rowCount: 0 }; },
        liberar: () => log.push('marcador: liberada'), descartar: () => log.push('marcador: descartada'),
    });
    assert.equal(await transacaoIndependenteDaExecucao(true, principal, abrir, transacaoComPrazo, 1000)(async () => 'ok'), 'ok');
    assert.deepEqual(log, ['marcador: BEGIN', 'marcador: COMMIT', 'marcador: liberada']);
    log.length = 0;
    await assert.rejects(transacaoIndependenteDaExecucao(true, principal, abrir, transacaoComPrazo, 1000)(async () => { throw new Error('falha'); }), /falha/);
    assert.deepEqual(log, ['marcador: BEGIN', 'marcador: ROLLBACK', 'marcador: liberada']);
    log.length = 0;
    assert.equal(await transacaoIndependenteDaExecucao(false, principal, null)(async (tx) => (tx === principal ? 'principal' : 'outra')), 'principal');
    assert.deepEqual(log, ['principal: SAVEPOINT kidmais_simulacao_marcador', 'principal: RELEASE SAVEPOINT kidmais_simulacao_marcador'], 'simulação: nada fora da transação desfeita');
    assert.throws(() => transacaoIndependenteDaExecucao(true, principal, abrir), /com prazo/);
    assert.throws(() => transacaoIndependenteDaExecucao(true, principal, null, transacaoComPrazo, 1000), /com prazo/);
});

test('reconciliação: alvo explícito e confirmado; DATABASE_URL nunca é usada; bancos proibidos recusados; simulação por padrão', () => {
    assert.throws(() => validarAlvo({ DATABASE_URL: url('kidmais_staging') }), /KIDMAIS_RECONCILIAR_DATABASE_URL/);
    assert.throws(() => validarAlvo({ DATABASE_URL: url('x'), KIDMAIS_RECONCILIAR_DATABASE_URL: url('x'), KIDMAIS_RECONCILIAR_ALVO: 'x@127.0.0.1:55532' }), /não a DATABASE_URL/);
    for (const db of ['kidmais_manager', 'kidmais_production', 'kidmais-production'])
        assert.throws(() => validarAlvo({ KIDMAIS_RECONCILIAR_DATABASE_URL: url(db), KIDMAIS_RECONCILIAR_ALVO: `${db}@127.0.0.1:55532` }), /recusado/);
    assert.throws(() => validarAlvo({ KIDMAIS_RECONCILIAR_DATABASE_URL: url('kidmais_sandbox') }), /KIDMAIS_RECONCILIAR_ALVO="kidmais_sandbox@127.0.0.1:55532"/);
    assert.throws(() => validarAlvo({ KIDMAIS_RECONCILIAR_DATABASE_URL: url('kidmais_sandbox'), KIDMAIS_RECONCILIAR_ALVO: 'kidmais_sandbox@127.0.0.1:5432' }), /Confirme o alvo/);
    try {
        validarAlvo({ KIDMAIS_RECONCILIAR_DATABASE_URL: url('kidmais_sandbox') });
    }
    catch (e) {
        assert.ok(!(e as Error).message.includes('senha-sintetica'), 'a mensagem nunca leva a conexão');
    }
    assert.deepEqual(validarAlvo({ KIDMAIS_RECONCILIAR_DATABASE_URL: url('kidmais_sandbox'), KIDMAIS_RECONCILIAR_ALVO: 'kidmais_sandbox@127.0.0.1:55532' }),
        { connectionString: url('kidmais_sandbox'), database: 'kidmais_sandbox', host: '127.0.0.1', port: 55532, local: true });
    assert.deepEqual(argumentos([]), { aplicar: false });
    assert.deepEqual(argumentos(['--aplicar']), { aplicar: true });
    assert.throws(() => argumentos(['--forcar']), /desconhecido/);
});

test('reconciliação em SIMULAÇÃO nunca remove nada no provedor (o ROLLBACK do banco não desfaz o provedor); --aplicar usa o provedor real', async () => {
    const chamadas: string[] = [];
    const real = { removerAssinatura: async (id?: string) => { chamadas.push(`remover:${id}`); return { removida: true }; }, listarAssinaturasPorReferencia: async () => [] };
    const relatorio: Record<string, unknown> = {};
    const simulado = provedorDaExecucao(real, false, relatorio);
    assert.deepEqual(await simulado.removerAssinatura('sub_1'), { removida: false });
    assert.deepEqual(chamadas, [], 'nenhuma remoção real na simulação');
    assert.equal(relatorio.removeriaNoProvedor, 1);
    assert.equal(provedorDaExecucao(real, true, {}), real);
});