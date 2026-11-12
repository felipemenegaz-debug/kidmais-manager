import assert from 'node:assert/strict';
import test from 'node:test';
import { carregarModulo } from '../acessos/teste-carregador.ts';

/**
 * Painel, arrependimento (23/10/2026): os e-mails do registro pelo atendimento e da conclusão saem só DEPOIS do COMMIT
 * (comPosCommit); a falha deles nunca desfaz nem derruba a operação gravada. Sem banco nem rede.
 */
type ComPosCommit = <T extends Record<string, unknown>>(w: (t: (tx: unknown) => Promise<T>) => Promise<T>,
    trabalho: (tx: unknown, depois: (acao: () => Promise<Record<string, unknown>>) => void) => Promise<T>) => Promise<T>;
const { comPosCommit } = carregarModulo('lib/desenvolvedor/comercial.ts', { 'desenvolvedor/interessadas': { painelDepsPadrao: {} } }) as { comPosCommit: ComPosCommit };

function transacaoFalsa(log: string[]) {
    return async <T>(t: (tx: unknown) => Promise<T>) => {
        log.push('BEGIN');
        try { const r = await t({}); log.push('COMMIT'); return r; }
        catch (e) { log.push('ROLLBACK'); throw e; }
    };
}

test('ação posterior roda depois do COMMIT e soma o resultado à resposta', async () => {
    const log: string[] = [];
    const r = await comPosCommit(transacaoFalsa(log), async (_tx, depois) => {
        log.push('grava');
        depois(async () => { log.push('e-mail'); return { emailConclusao: 'ENVIADO' }; });
        return { protocolo: 'KA-20261023-ABCDEFGH' };
    });
    assert.deepEqual(log, ['BEGIN', 'grava', 'COMMIT', 'e-mail']);
    assert.deepEqual(r, { protocolo: 'KA-20261023-ABCDEFGH', emailConclusao: 'ENVIADO' });
});

test('falha da ação posterior não derruba a operação gravada', async () => {
    const log: string[] = [];
    const r = await comPosCommit(transacaoFalsa(log), async (_tx, depois) => {
        depois(async () => { throw new Error('smtp'); });
        return { protocolo: 'KA-20261023-ABCDEFGH' };
    });
    assert.deepEqual(log, ['BEGIN', 'COMMIT']);
    assert.deepEqual(r, { protocolo: 'KA-20261023-ABCDEFGH' });
});

test('transação desfeita: a ação posterior não roda', async () => {
    const log: string[] = [];
    let rodou = false;
    await assert.rejects(comPosCommit(transacaoFalsa(log), async (_tx, depois) => {
        depois(async () => { rodou = true; return {}; });
        throw new Error('CONFLITO');
    }), /CONFLITO/);
    assert.deepEqual(log, ['BEGIN', 'ROLLBACK']);
    assert.equal(rodou, false);
});

test('sem ação posterior: devolve o resultado da transação', async () => {
    const r = await comPosCommit(transacaoFalsa([]), async () => ({ ok: true }));
    assert.deepEqual(r, { ok: true });
});
