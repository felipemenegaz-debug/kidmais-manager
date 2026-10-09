import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { conexaoDeClientePg, PrazoDaTransacaoVencido, transacaoComPrazo } from '../db/transacao-com-prazo.ts';

/**
 * D1, abertura da conexão do marcador no script (revisão independente D1/D2, P2 de 09/10/2026: reprodução
 * abertura-script-sem-resposta.mjs convertida em teste permanente). Componentes reais — abrirConexaoDoMarcador do script e
 * transacaoComPrazo — com um cliente `pg` falso: nenhum banco, nenhuma rede.
 */
const req = createRequire(import.meta.url);
const { abrirConexaoDoMarcador } = req('../../scripts/assinatura-reconciliar.cjs') as {
    abrirConexaoDoMarcador: (Client: unknown, alvo: unknown, adaptar: unknown, registrar?: unknown) => Promise<unknown>;
};
const ALVO = { connectionString: 'postgresql://sintetico@127.0.0.1:1/sintetico', local: true, database: 'kidmais_sintetico' };
const PRAZO = 40;
const nunca = () => new Promise<never>(() => undefined);

type Modo = { conectar?: 'ok' | 'nunca' | number; banco?: 'nunca' | string };
function clienteFalso(modo: Modo) {
    const estado = { destruicoes: 0, encerramentos: 0, consultas: [] as string[] };
    class ClienteFalso {
        connection = { stream: { destroy: () => { estado.destruicoes += 1; } } };
        on() { return this; }
        async connect() {
            if (modo.conectar === 'nunca') return nunca();
            if (typeof modo.conectar === 'number') await new Promise((ok) => setTimeout(ok, modo.conectar as number));
        }
        async end() { estado.encerramentos += 1; }
        query(sql: string) {
            estado.consultas.push(sql);
            if (sql.startsWith('SELECT current_database()')) return modo.banco === 'nunca' ? nunca() : Promise.resolve({ rows: [{ db: modo.banco ?? ALVO.database }], rowCount: 1 });
            return Promise.resolve({ rows: [], rowCount: 0 });
        }
    }
    const tx = transacaoComPrazo((registrar) => abrirConexaoDoMarcador(ClienteFalso, ALVO, conexaoDeClientePg, registrar) as never, PRAZO);
    return { tx, estado };
}
const trabalhoProibido = async () => { throw new Error('o trabalho de negócio não pode começar'); };

test('P2 (reprodução): connect responde, current_database NUNCA responde → prazo finito, soquete destruído, nenhum BEGIN nem trabalho', async () => {
    const { tx, estado } = clienteFalso({ conectar: 'ok', banco: 'nunca' });
    const t0 = Date.now();
    await assert.rejects(tx(trabalhoProibido), PrazoDaTransacaoVencido);
    assert.ok(Date.now() - t0 < PRAZO + 500, 'prazo finito');
    assert.deepEqual(estado.consultas, ['SELECT current_database() AS db'], 'nenhuma escrita: nem BEGIN');
    assert.deepEqual([estado.destruicoes, estado.encerramentos], [1, 1], 'soquete destruído e conexão encerrada uma única vez');
});

test('D1, abertura: connect NUNCA responde → prazo finito, soquete destruído; nada consultado', async () => {
    const { tx, estado } = clienteFalso({ conectar: 'nunca' });
    await assert.rejects(tx(trabalhoProibido), PrazoDaTransacaoVencido);
    assert.deepEqual([estado.consultas, estado.destruicoes, estado.encerramentos], [[], 1, 1]);
});

test('D1, abertura: banco divergente → recusa antes de qualquer escrita e encerra a conexão (uma vez, sem descarte duplicado)', async () => {
    const { tx, estado } = clienteFalso({ conectar: 'ok', banco: 'outro_banco' });
    await assert.rejects(tx(trabalhoProibido), /Alvo recusado/);
    assert.deepEqual(estado.consultas, ['SELECT current_database() AS db']);
    assert.deepEqual([estado.destruicoes, estado.encerramentos], [1, 1]);
});

test('D1, abertura entregue DEPOIS do prazo (connect lento) → a transação falha no prazo e a conexão é descartada quando chega; nada de negócio enviado', async () => {
    const { tx, estado } = clienteFalso({ conectar: PRAZO * 3 });
    await assert.rejects(tx(trabalhoProibido), PrazoDaTransacaoVencido);
    assert.equal(estado.destruicoes, 1, 'descartada no prazo (estava registrada desde antes de conectar)');
    await new Promise((ok) => setTimeout(ok, PRAZO * 4));
    assert.ok(!estado.consultas.includes('BEGIN'), 'nenhum BEGIN depois do prazo');
    assert.deepEqual([estado.destruicoes, estado.encerramentos], [1, 1], 'nada fechado duas vezes');
});

test('D1, abertura normal: confere o banco, BEGIN, trabalho, COMMIT e encerra uma vez, sem descarte', async () => {
    const { tx, estado } = clienteFalso({ conectar: 'ok' });
    assert.equal(await tx(async (t) => { await t.query('INSERT INTO marcador'); return 'ok'; }), 'ok');
    assert.deepEqual(estado.consultas, ['SELECT current_database() AS db', 'BEGIN', 'INSERT INTO marcador', 'COMMIT']);
    assert.deepEqual([estado.destruicoes, estado.encerramentos], [0, 1]);
});
