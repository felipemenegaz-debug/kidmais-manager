import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

/** Guarda de alvo da reconciliação (scripts/assinatura-reconciliar.cjs), sem conectar em banco nenhum. */
const req = createRequire(import.meta.url);
const { validarAlvo, argumentos } = req('../../scripts/assinatura-reconciliar.cjs') as {
    validarAlvo: (env: Record<string, string | undefined>) => { database: string; host: string; port: number; local: boolean };
    argumentos: (argv: string[]) => { aplicar: boolean };
};
const url = (db: string, host = '127.0.0.1', porta = '55532') => `postgresql://u:senha-sintetica@${host}:${porta}/${db}`;

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
