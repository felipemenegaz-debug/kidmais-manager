import assert from 'node:assert/strict';
import test from 'node:test';
import { provisionar } from '../../scripts/admin-provision.cjs';

const empresaId = '00000000-0000-4000-8000-000000000021';
const alvoId = '00000000-0000-4000-8000-000000000022';
const operadorId = '00000000-0000-4000-8000-000000000023';
const colegaId = '00000000-0000-4000-8000-000000000024';

function cliente(admins: Array<{ empresa_id: string; usuario_id: string; papel: string; ativo: boolean }>) {
    const sqls: string[] = [];
    const consultas = {
        async query(sql: string, params: readonly unknown[] = []) {
            sqls.push(sql);
            if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK' || sql.includes('pg_advisory_xact_lock'))
                return { rows: [], rowCount: 0 };
            if (sql.includes('count(*)'))
                return { rows: [{ n: 2 }], rowCount: 1 };
            if (sql.includes('to_regclass'))
                return { rows: [{ empresas: 'perfil_empresas', concessoes: 'perfil_empresa_concessoes' }], rowCount: 1 };
            if (sql.includes('FROM public.perfil_empresas ORDER BY id'))
                return { rows: [{ id: empresaId }], rowCount: 1 };
            if (sql.includes('WHERE email=$1 FOR UPDATE')) {
                const email = String(params[0]);
                const id = email.startsWith('op') ? operadorId : alvoId;
                return { rows: [{ id, email, nome: 'Ana', papel: 'REPRESENTANTE_AUTORIZADO', ativo: true }], rowCount: 1 };
            }
            if (sql.includes('FOR UPDATE OF c'))
                return { rows: admins, rowCount: admins.length };
            if (sql.includes('SELECT id FROM public.perfil_empresa_concessoes'))
                return { rows: [{ id: 'grant-1' }], rowCount: 1 };
            if (sql.includes('UPDATE usuarios_administrativos SET papel'))
                return { rows: [{ id: alvoId, email: 'ana@example.invalid', nome: 'Ana', papel: params[1], ativo: params[2] }], rowCount: 1 };
            if (sql.includes('UPDATE public.perfil_empresa_concessoes'))
                return { rows: [{ id: 'grant-1', empresa_id: empresaId, capacidade: 'PERFIL_CONSULTAR' }], rowCount: 1 };
            if (sql.includes('INSERT INTO auditoria') || sql.includes('UPDATE sessoes_administrativas'))
                return { rows: [], rowCount: 1 };
            throw new Error(sql);
        },
    };
    return { sqls, consultas };
}

const pedido = {
    acao: 'atualizar',
    email: 'ana@example.invalid',
    nome: '',
    cargo: '',
    papel: 'ADMINISTRATIVO',
    ativo: true,
    senha: null,
    operadorEmail: 'op@example.invalid',
};

test('atualizar trava a empresa antes da conta e não abre conexão', async () => {
    const banco = cliente([
        { empresa_id: empresaId, usuario_id: alvoId, papel: 'REPRESENTANTE_AUTORIZADO', ativo: true },
        { empresa_id: empresaId, usuario_id: colegaId, papel: 'REPRESENTANTE_AUTORIZADO', ativo: true },
    ]);
    await provisionar(banco.consultas, pedido);
    const trava = banco.sqls.findIndex((sql) => sql.includes('pg_advisory_xact_lock'));
    const conta = banco.sqls.findIndex((sql) => sql.includes('WHERE email=$1 FOR UPDATE'));
    const grants = banco.sqls.findIndex((sql) => sql.includes('FOR UPDATE OF c'));
    assert.ok(trava >= 0 && trava < conta && conta < grants);
    assert.equal(banco.sqls.some((sql) => sql.includes('LOCK TABLE')), false);
    assert.equal('connect' in banco.consultas, false);
});

test('a última administradora não muda de papel pelo script', async () => {
    const banco = cliente([
        { empresa_id: empresaId, usuario_id: alvoId, papel: 'REPRESENTANTE_AUTORIZADO', ativo: true },
    ]);
    await assert.rejects(() => provisionar(banco.consultas, pedido), /última que administra/);
    assert.equal(banco.sqls.some((sql) => sql.includes('UPDATE usuarios_administrativos SET papel')), false);
    assert.equal(banco.sqls.includes('COMMIT'), true);
    assert.equal(banco.sqls.includes('ROLLBACK'), false);
});
