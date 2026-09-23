import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { hashSnapshotContrato } from './snapshot-core.ts';

const require = createRequire(import.meta.url);
function carregar(mocks: Record<string, unknown>) {
    const exports: Record<string, unknown> = {};
    const source = readFileSync('lib/contratos/services/administrativo.service.ts', 'utf8');
    const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
    new Function('require', 'exports', code)((name: string) => name in mocks ? mocks[name] : ['zod', 'node:crypto'].includes(name) ? require(name) : {}, exports);
    return exports.operarContrato as (id: string, body: object, token: string, context: object) => Promise<unknown>;
}

function caso(options: { status?: string; clienteAssinou?: boolean; temFinanceiro?: boolean; capacidade?: boolean } = {}) {
    const snapshot = { contratante: { clienteId: 'cliente' } };
    const versao = { id: 'versao', contratoId: 'contrato', snapshot, snapshotHash: hashSnapshotContrato(snapshot) };
    const escritos: string[] = [];
    const auditoria: unknown[] = [];
    const tx = { query: async (sql: string) => {
        if (/^(UPDATE|INSERT|DELETE)/.test(sql)) escritos.push(sql);
        const rows = sql.startsWith('SELECT id,fechamento_id,status FROM contratos') ? [{ id: 'contrato', fechamento_id: 'fechamento', status: options.status ?? 'AGUARDANDO_ASSINATURA' }]
            : sql.startsWith('SELECT * FROM contrato_fluxos') ? [{ versao_vigente_id: null, versao_em_preparacao_id: 'versao' }]
            : sql.startsWith('SELECT status FROM contratos') ? [{ status: options.status ?? 'AGUARDANDO_ASSINATURA' }]
            : sql.includes('FROM festa_usuario_capacidades') ? options.capacidade === false ? [] : [{ id: 'capacidade' }]
            : sql.includes('FROM contrato_assinaturas') ? options.clienteAssinou ? [{ id: 'assinatura' }] : []
            : sql.includes('FROM pagamentos p') ? options.temFinanceiro ? [{ id: 'pagamento' }] : []
            : [];
        return { rows };
    } };
    const operar = carregar({
        '../../db/postgres': { withTransaction: async (fn: (tx: unknown) => unknown) => fn(tx) },
        '../../autenticacao/service': { consultarSessao: async () => ({ usuario_id: 'usuario', nome: 'Gestor', papel: 'REPRESENTANTE_AUTORIZADO' }), authError: (message: string) => new Error(message) },
        '../../fechamentos/services/edicao-administrativa-schema': { edicaoFestaSchema: require('zod').z.object({ acao: require('zod').z.literal('editar_festa') }) },
        './snapshot-core': { hashSnapshotContrato },
        './errors': { ContratoServiceError: class extends Error {} },
        '../repositories': { buscarVersaoPorId: async () => versao },
        '../../fechamentos/repositories/revisao.repository': { buscarRevisaoDaVersao: async () => null },
        '../../clientes/repositories': { registrarAuditoria: async (value: unknown) => { auditoria.push(value); }, registrarEventoHistorico: async () => {} },
    });
    return { operar: () => operar('versao', { acao: 'cancelar_contratacao', motivo: 'Cliente desistiu' }, 'sessao', { requestId: 'pedido', ip: null, userAgent: null }), escritos, auditoria };
}

test('cancelamento antes da formalização registra motivo e encerra contrato e fechamento', async () => {
    const c = caso();
    assert.deepEqual(await c.operar(), { cancelada: true });
    assert(c.escritos.some(sql => sql.startsWith("UPDATE contratos SET status='CANCELADO'")));
    assert(c.escritos.some(sql => sql.startsWith("UPDATE fechamentos SET status='CANCELADO'")));
    assert.equal((c.auditoria[0] as { dadosDepois: { motivo: string } }).dadosDepois.motivo, 'Cliente desistiu');
});

for (const [name, options] of [
    ['contrato assinado', { status: 'ASSINADO' }],
    ['assinatura do cliente', { clienteAssinou: true }],
    ['financeiro', { temFinanceiro: true }],
    ['sem permissão', { capacidade: false }],
] as const) test(`recusa ${name} sem escrita`, async () => {
    const c = caso(options);
    await assert.rejects(c.operar());
    assert.deepEqual(c.escritos, []);
});
