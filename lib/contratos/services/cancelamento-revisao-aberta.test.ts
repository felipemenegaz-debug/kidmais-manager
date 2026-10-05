import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { FestaError, exigir } from '../../festas/domain.ts';

type Cancelar = (tx: unknown, id: string, s: unknown, motivo: string, chave: string, ctx: unknown, autoridade: unknown) => Promise<unknown>;
function carregar(mocks: Record<string, unknown>) {
    const exports: Record<string, unknown> = {};
    const source = readFileSync('lib/contratos/services/cancelamento.service.ts', 'utf8');
    const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
    new Function('require', 'exports', code)((name: string) => name in mocks ? mocks[name] : {}, exports);
    return exports.cancelarContratacaoDaFesta as Cancelar;
}
function caso(op: { revisaoAberta?: number | null } = {}) {
    const sql: string[] = [];
    let financeiroCancelado = false;
    const tx = { query: async (text: string) => {
        sql.push(text);
        const rows: object[] = text.includes('FROM festa_membership_capacidades') ? [{ id: 'cap' }]
            : text.startsWith('SELECT c.*') ? [{ id: 'contrato', status: 'ASSINADO', cancelado_em: null, cliente_id: 'cliente' }]
            : text.includes('FROM fechamento_revisoes r JOIN contrato_versoes v') ? (op.revisaoAberta ? [{ numero_versao: op.revisaoAberta }] : [])
            : text.startsWith('UPDATE contratos') ? [{ cancelado_em: '2026-10-05T23:30:00Z' }]
            : [];
        return { rows, rowCount: rows.length };
    } };
    const cancelar = carregar({
        '../../festas/domain': { exigir },
        '../../clientes/repositories/historico.repository': { registrarEventoHistorico: async () => undefined },
        '../../clientes/repositories/auditoria.repository': { registrarAuditoria: async () => undefined },
        '../../pagamentos/services/cancelamento.service': { cancelarFinanceiroDaContratacao: async () => { financeiroCancelado = true; } },
    });
    const executar = () => cancelar(tx, 'contrato', { usuario_id: 'u', nome: 'Gestor' }, 'Cliente desistiu', 'chave', { requestId: 'r', userAgent: null },
        { membershipId: 'm', empresaId: 'e', papel: 'GESTAO' });
    return { executar, sql, financeiro: () => financeiroCancelado };
}
test('contrato com revisão em andamento não é cancelado: recusa clara (409) e nenhuma escrita', async () => {
    const c = caso({ revisaoAberta: 2 });
    await assert.rejects(c.executar(), (e: unknown) => e instanceof FestaError && e.status === 409 && /revisão em andamento \(V2\)/.test(e.message) && /Cancele a revisão antes/.test(e.message));
    assert.ok(c.sql.every(q => !/^(UPDATE|INSERT)/.test(q)), 'nada escrito');
    assert.equal(c.financeiro(), false);
    // O serviço não tenta mais encerrar a revisão na mesma transação (a regra de fluxo da 013 recusaria no commit).
    assert.ok(c.sql.every(q => !q.includes('FOR UPDATE') || q.startsWith('SELECT c.*')));
});
test('sem revisão aberta o cancelamento segue: financeiro cancelado e contrato marcado', async () => {
    const c = caso({ revisaoAberta: null });
    const detail = await c.executar() as { contratoId: string; canceladoEm: string };
    assert.equal(detail.contratoId, 'contrato');
    assert.equal(c.financeiro(), true);
    assert.ok(c.sql.some(q => q.startsWith('UPDATE contratos') && q.includes("status='CANCELADO'")));
});
