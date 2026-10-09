import assert from 'node:assert/strict';
import test from 'node:test';
import { carregarModulo, executorFalso } from '../acessos/teste-carregador.ts';
import type { DbExecutor } from '../db/contracts';

const empresa = '11111111-1111-4111-8111-111111111111';
type Vagas = { limite: number | null; ocupadas: number; disponiveis: number | null; excedido: boolean };
function cenario(plano: string | null, ativos = 1, pendentes = 0, instalado = true, isenta = false) {
    const mod = carregarModulo('lib/assinatura/limites-usuarios.ts', {
        'assinatura/ofertas': { schemaPlanosInstalado: async () => instalado, empresaIsenta: async () => isenta },
    }) as {
        consultarVagas(tx: DbExecutor, id: string): Promise<Vagas | null>;
        exigirVaga(tx: DbExecutor, id: string, adicional?: 0 | 1): Promise<Vagas | null>;
    };
    const tx = executorFalso([
        [/SELECT c.plano/, () => plano ? [{ plano }] : []],
        [/AS ativos/, () => [{ ativos, pendentes }]],
    ]);
    return { mod, tx: tx as unknown as DbExecutor & typeof tx };
}

test('Gestão e convites reservam vagas; limites 3, 10 e ilimitado', async () => {
    for (const [plano, limite] of [['ESSENCIAL', 3], ['PROFISSIONAL', 10], ['PREMIUM', null]] as const) {
        const { mod, tx } = cenario(plano, 2, 1);
        const v = await mod.consultarVagas(tx, empresa);
        assert.equal(v?.limite, limite);
        assert.equal(v?.ocupadas, 3);
        assert.equal(v?.disponiveis, limite === null ? null : limite - 3);
        assert.ok(tx.executados.every(q => q.params[0] === empresa));
        const sql = tx.executados.at(-1)!.sql;
        assert.match(sql, /u.ativo/);
        assert.match(sql, /expira_em>clock_timestamp/);
        assert.match(sql, /NOT EXISTS/);
    }
});

test('nova reserva bloqueada no limite; acesso acima do limite preservado', async () => {
    for (const ocupadas of [3, 5]) {
        const { mod, tx } = cenario('ESSENCIAL', ocupadas);
        await assert.rejects(mod.exigirVaga(tx, empresa), { code: 'LIMITE_USUARIOS_PLANO' });
        assert.match(tx.executados[0].sql, /FOR UPDATE/);
        assert.ok(!tx.executados.some(q => /UPDATE memberships|DELETE|INSERT/.test(q.sql)));
        const v = await mod.exigirVaga(tx, empresa, 0);
        assert.equal(v?.ocupadas, ocupadas, 'aceitar reserva válida não aumenta ocupação');
    }
});

test('trial, legado, isenção e schema anterior preservam acesso', async () => {
    for (const [plano, instalado, isenta] of [[null, true, false], ['ESSENCIAL', false, false], ['ESSENCIAL', true, true]] as const) {
        const { mod, tx } = cenario(plano, 50, 10, instalado, isenta);
        assert.equal(await mod.exigirVaga(tx, empresa), null);
    }
    const { mod, tx } = cenario('PREMIUM', 50, 10);
    assert.equal((await mod.exigirVaga(tx, empresa))?.limite, null);
});

test('plano desconhecido e contagem inválida impedem novas reservas', async () => {
    for (const [plano, ativos] of [['INVALIDO', 1], ['ESSENCIAL', -1], ['ESSENCIAL', NaN]] as const) {
        const { mod, tx } = cenario(plano, ativos);
        await assert.rejects(mod.exigirVaga(tx, empresa), { code: 'PLANOS_NAO_DISPONIVEIS' });
    }
});
