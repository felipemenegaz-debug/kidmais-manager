import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { carregarModulo, executorFalso } from '../acessos/teste-carregador.ts';
import type { DbExecutor } from '../db/contracts';

const empresa = '11111111-1111-4111-8111-111111111111';
type Mod = {
    recursoIncluido(tx: DbExecutor, id: string, recurso: 'FINANCEIRO_COMPLETO'): Promise<boolean>;
    exigirRecursoPlano(tx: DbExecutor, id: string, recurso: 'FINANCEIRO_COMPLETO'): Promise<void>;
};
function cenario(plano: string | null, instalado = true, isenta = false) {
    const mod = carregarModulo('lib/assinatura/recursos-plano.ts', {
        'assinatura/ofertas': { schemaPlanosInstalado: async () => instalado, empresaIsenta: async () => isenta },
    }) as Mod;
    const tx = executorFalso([[/SELECT c.plano/, () => plano ? [{ plano }] : []]]);
    return { mod, tx: tx as unknown as DbExecutor & typeof tx };
}

test('financeiro completo: Essencial recusa no servidor; Profissional e Premium incluem', async () => {
    const { mod, tx } = cenario('ESSENCIAL');
    await assert.rejects(mod.exigirRecursoPlano(tx, empresa, 'FINANCEIRO_COMPLETO'), (e: { code: string; httpStatus: number }) =>
        e.code === 'RECURSO_FORA_DO_PLANO' && e.httpStatus === 403);
    assert.ok(tx.executados.every(q => q.params[0] === empresa));
    assert.match(tx.executados[0].sql, /estado='CONFIRMADA'/);
    for (const plano of ['PROFISSIONAL', 'PREMIUM']) {
        const c = cenario(plano);
        assert.equal(await c.mod.recursoIncluido(c.tx, empresa, 'FINANCEIRO_COMPLETO'), true);
        await c.mod.exigirRecursoPlano(c.tx, empresa, 'FINANCEIRO_COMPLETO');
    }
});

test('teste, legado, isenção e schema ausente preservam o recurso', async () => {
    for (const [plano, instalado, isenta] of [[null, true, false], ['ESSENCIAL', true, true], ['ESSENCIAL', false, false]] as const) {
        const { mod, tx } = cenario(plano, instalado, isenta);
        assert.equal(await mod.recursoIncluido(tx, empresa, 'FINANCEIRO_COMPLETO'), true);
        if (isenta || !instalado) assert.equal(tx.executados.length, 0);
    }
});

test('plano desconhecido falha fechado, sem conceder recurso pago', async () => {
    const { mod, tx } = cenario('OURO');
    await assert.rejects(mod.recursoIncluido(tx, empresa, 'FINANCEIRO_COMPLETO'), { code: 'PLANOS_NAO_DISPONIVEIS' });
});

test('isolamento: o plano consultado é sempre o da empresa comprovada; uma empresa não herda o plano da outra', async () => {
    const outra = '22222222-2222-4222-8222-222222222222';
    const mod = carregarModulo('lib/assinatura/recursos-plano.ts', {
        'assinatura/ofertas': { schemaPlanosInstalado: async () => true, empresaIsenta: async () => false },
    }) as Mod;
    const tx = executorFalso([[/SELECT c.plano/, (p) => [{ plano: p[0] === empresa ? 'ESSENCIAL' : 'PROFISSIONAL' }]]]) as unknown as DbExecutor & { executados: Array<{ params: unknown[] }> };
    assert.equal(await mod.recursoIncluido(tx, empresa, 'FINANCEIRO_COMPLETO'), false);
    assert.equal(await mod.recursoIncluido(tx, outra, 'FINANCEIRO_COMPLETO'), true);
    assert.deepEqual(tx.executados.map((q) => q.params[0]), [empresa, outra]);
});

test('serviço: sem o recurso, painel e festa não leem nem materializam contas a pagar; com o recurso, inalterados', async () => {
    const { painelGeral, financeiroDaFesta } = await import('../financeiro/servico.ts');
    const banco = () => {
        const sqls: string[] = [];
        const tx = { async query(sql: string) { sqls.push(sql); return { rows: [], rowCount: 0 }; } } as unknown as DbExecutor;
        return { tx, tocouContas: () => sqls.some((s) => /financeiro_contas_pagar/.test(s)) };
    };
    const essencial = banco();
    const painel = await painelGeral(essencial.tx, empresa, '2026-10-10', false);
    assert.equal(painel.financeiroCompleto, false);
    assert.equal(painel.numeros.aPagarCentavos, 0);
    const festa = await financeiroDaFesta(essencial.tx, empresa, '33333333-3333-4333-8333-333333333333', '2026-10-10', false);
    assert.equal(festa.despesasIncluidas, false);
    assert.equal(festa.custosCentavos, null);
    assert.deepEqual(festa.despesas, []);
    assert.equal(essencial.tocouContas(), false);
    const completo = banco();
    assert.equal((await painelGeral(completo.tx, empresa, '2026-10-10')).financeiroCompleto, true);
    assert.equal((await financeiroDaFesta(completo.tx, empresa, '33333333-3333-4333-8333-333333333333', '2026-10-10')).despesasIncluidas, true);
    assert.equal(completo.tocouContas(), true);
});

test('cobertura: todo caminho de contas a pagar, fluxo e relatórios passa pela barreira do plano no servidor', () => {
    const fonte = (arquivo: string) => readFileSync(arquivo, 'utf8');
    for (const rota of ['app/api/admin/financeiro/fluxo-caixa/route.ts', 'app/api/admin/financeiro/relatorios/route.ts'])
        assert.match(fonte(rota), /consultarFinanceiro\([\s\S]*"FINANCEIRO_COMPLETO"\)/, rota);
    const pagar = fonte('app/api/admin/financeiro/contas-pagar/route.ts');
    assert.match(pagar, /\}\), "FINANCEIRO_COMPLETO"\);/, 'GET contas a pagar');
    assert.match(pagar, /withTenantTransaction\(sessao, null, async \(tx, tenant\) => \{\s*const empresaId = tenant\.empresaComprovada;\s*await exigirRecursoPlano\(tx, empresaId, "FINANCEIRO_COMPLETO"\);/, 'POST contas a pagar');
    const festa = fonte('app/api/admin/festas/[festaId]/financeiro/route.ts');
    assert.match(festa, /await exigirRecursoPlano\(tx, tenant\.empresaComprovada, "FINANCEIRO_COMPLETO"\);\s*return criarContaPagar/, 'despesa da festa');
    assert.match(festa, /financeiroDaFesta\([^;]*?await recursoIncluido\(tx, tenant\.empresaComprovada, "FINANCEIRO_COMPLETO"\)\)/, 'leitura da festa');
    assert.match(fonte('app/api/admin/dashboard/route.ts'), /painelGeral\([^;]*?await recursoIncluido\(tx, tenant\.empresaComprovada, "FINANCEIRO_COMPLETO"\)\)/, 'dashboard');
    assert.match(fonte('app/api/admin/financeiro/route.ts'), /recursoIncluido\(tx, empresaId, "FINANCEIRO_COMPLETO"\)/, 'visão geral');
    const ia = fonte('app/api/admin/inteligencia/operacoes/composicao.ts');
    assert.equal((ia.match(/await exigirRecursoPlano\(tx, empresaId, "FINANCEIRO_COMPLETO"\)/g) ?? []).length, 2, 'ação IA: revisão e execução');
    assert.match(fonte('app/api/admin/inteligencia/dependencias.ts'), /recursos: \{ financeiroCompleto: \(tx, empresaId\) => recursoIncluido\(tx, empresaId, "FINANCEIRO_COMPLETO"\) \}/);
    // Nenhuma outra rota chama os serviços do financeiro completo sem passar por aqui.
    const servicos = /\b(listarContasPagar|pagoNoPeriodo|fluxoCaixa|relatorio|criarContaPagar|editarContaPagar|pagarConta|cancelarConta|painelGeral|financeiroDaFesta)\(/;
    const conhecidas = new Set(['app/api/admin/financeiro/route.ts', 'app/api/admin/financeiro/contas-pagar/route.ts', 'app/api/admin/financeiro/fluxo-caixa/route.ts',
        'app/api/admin/financeiro/relatorios/route.ts', 'app/api/admin/festas/[festaId]/financeiro/route.ts', 'app/api/admin/dashboard/route.ts']);
    const rotas = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? rotas(`${dir}/${e.name}`) : e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [`${dir}/${e.name}`] : []);
    const fora = rotas('app').filter((arquivo) => servicos.test(fonte(arquivo)) && !conhecidas.has(arquivo) && arquivo !== 'app/api/admin/inteligencia/operacoes/composicao.ts');
    assert.deepEqual(fora, []);
});