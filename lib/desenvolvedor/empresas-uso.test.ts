import assert from 'node:assert/strict';
import test from 'node:test';
import { carregarModulo, executorFalso } from '../acessos/teste-carregador.ts';

/**
 * Contratantes fase 2 (23/11/2026, D-INT-1): cada contratante é CLIENTE (padrão) ou INTERNA (teste, demonstração,
 * suporte), na tabela da 134. "Em uso" mostra só clientes não desativadas e conta à parte as internas ocultas.
 * Sem a 134, tudo conta como CLIENTE, a consulta nunca cita a tabela e a marcação responde 409.
 */
type Lista = { itens: Array<{ uso: string }>; total: number; desativadasOcultas: number; internasOcultas: number; usoDisponivel: boolean };
const sessao = { id: 's', usuario_id: '00000000-0000-4000-8000-000000000001', papel: 'ADMINISTRATIVO' };
const EMPRESA = '00000000-0000-4000-8000-0000000000e1';
const ctx = { requestId: 'r', ip: null, userAgent: null };

function servico({ instalado = true, usoAtual = null as string | null } = {}) {
    const auditorias: unknown[] = [];
    const banco = executorFalso([
        [/FROM plataforma_desenvolvedores/, () => [{ id: 'd' }]],
        [/ AS agora$/, () => [{ agora: '2026-11-23T12:00:00.000Z' }]],
        [/to_regclass\('public\.plataforma_empresas_uso'\)/, () => [{ ok: instalado }]],
        [/WITH base AS MATERIALIZED/, (p) => [{ total: 7, desativadas: 3, internas: 2, id: EMPRESA, uso: p[1] === 'INTERNAS' ? 'INTERNA' : 'CLIENTE', status: 'ATIVA' }]],
        [/FOR UPDATE OF e/, () => [{ id: EMPRESA, codigo: 'x', nome: 'X', status: 'ATIVA' }]],
        [/SELECT uso FROM plataforma_empresas_uso/, () => usoAtual ? [{ uso: usoAtual }] : []],
    ]);
    const deps = { withTransaction: async (w: (t: typeof banco) => Promise<unknown>) => w(banco), registrarAuditoria: async (a: unknown) => { auditorias.push(a); } };
    const mod = carregarModulo('lib/desenvolvedor/empresas.ts', { 'db/postgres': { db: () => banco, withTransaction: deps.withTransaction } }) as {
        listarEmpresas: (s: unknown, r: unknown, d: unknown) => Promise<Lista>;
        alterarUsoEmpresa: (s: unknown, id: string, r: unknown, c: unknown, d: unknown) => Promise<{ uso: string; alterado: boolean }>;
    };
    return {
        listar: (raw: unknown) => mod.listarEmpresas(sessao, raw, deps),
        marcar: (raw: unknown, id = EMPRESA) => mod.alterarUsoEmpresa(sessao, id, raw, ctx, deps),
        banco, auditorias,
    };
}
const listagens = (banco: ReturnType<typeof servico>['banco']) => banco.executados.filter((e) => /FROM empresas e/.test(e.sql));

test('com a 134: Em uso exige CLIENTE, conta desativadas e internas com a mesma busca, sem se sobreporem, numa consulta só', async () => {
    const { listar, banco } = servico();
    const r = await listar({ situacao: 'EM_USO', busca: 'buffet' });
    assert.equal(r.total, 7);
    assert.equal(r.desativadasOcultas, 3);
    assert.equal(r.internasOcultas, 2);
    assert.equal(r.usoDisponivel, true);
    const l = listagens(banco);
    assert.equal(l.length, 1, 'página e contagens no mesmo snapshot (Astra r1 P2)');
    assert.doesNotMatch(l[0].sql, /SELECT count\(\*\)::int AS n/);
    assert.match(l[0].sql, /LEFT JOIN plataforma_empresas_uso u ON u\.empresa_id = e\.id/);
    assert.match(l[0].sql, /WHEN 'EM_USO' THEN e\.status <> 'DESATIVADA' AND COALESCE\(u\.uso, 'CLIENTE'\) = 'CLIENTE'/);
    assert.match(l[0].sql, /WHEN 'INTERNAS' THEN e\.status <> 'DESATIVADA' AND COALESCE\(u\.uso, 'CLIENTE'\) = 'INTERNA'/);
    assert.match(l[0].sql, /count\(\*\) FILTER \(WHERE status <> 'DESATIVADA' AND uso = 'INTERNA'\)/);
    assert.match(l[0].sql, /b\.uso/, 'o selo vem da mesma classificação da contagem');
    assert.deepEqual(l[0].params, ['%buffet%', 'EM_USO', '', 0]);
    // Astra r2 (P3): a página aplica o filtro antes do LIMIT; Em uso traz cliente.
    assert.match(l[0].sql, /WHERE b\.no_filtro\s+ORDER BY b\.ordem DESC, b\.id\s+LIMIT 25 OFFSET \$4/);
    assert.equal(r.itens.length, 1);
    assert.equal(r.itens[0].uso, 'CLIENTE');
});

test('com a 134: filtro Internas existe e não informa ocultas; outros filtros também não', async () => {
    for (const situacao of ['INTERNAS', 'TODAS', 'DESATIVADA']) {
        const { listar, banco } = servico();
        const r = await listar({ situacao });
        assert.equal(r.desativadasOcultas, 0);
        assert.equal(r.internasOcultas, 0);
        assert.equal(listagens(banco).length, 1, situacao);
        assert.equal(listagens(banco)[0].params[1], situacao);
        if (situacao === 'INTERNAS') assert.equal(r.itens[0].uso, 'INTERNA', 'selo de interna no filtro Internas');
    }
});

test('sem a 134: nenhuma consulta cita a tabela, todas contam como CLIENTE, sem internas ocultas', async () => {
    const { listar, banco } = servico({ instalado: false });
    const r = await listar({ situacao: 'EM_USO' });
    assert.equal(r.usoDisponivel, false);
    assert.equal(r.internasOcultas, 0);
    assert.equal(r.desativadasOcultas, 3);
    assert.equal(listagens(banco).length, 1);
    for (const e of banco.executados) assert.doesNotMatch(e.sql, /plataforma_empresas_uso u|FROM plataforma_empresas_uso/);
    assert.match(listagens(banco)[0].sql, /WHEN 'EM_USO' THEN e\.status <> 'DESATIVADA' AND 'CLIENTE' = 'CLIENTE'/);
});

test('marcar sem a 134: 409 antes de travar ou gravar', async () => {
    const { marcar, banco, auditorias } = servico({ instalado: false });
    await assert.rejects(marcar({ uso: 'INTERNA', motivo: 'conta de teste' }), (e: { httpStatus?: number; message?: string }) => e.httpStatus === 409 && /migration 134 pendente/.test(String(e.message)));
    assert.ok(!banco.executados.some((e) => /FOR UPDATE|INSERT INTO plataforma_empresas_uso/.test(e.sql)));
    assert.equal(auditorias.length, 0);
});

test('marcar como interna: trava a empresa, grava com quem marcou e audita antes/depois com o motivo', async () => {
    const { marcar, banco, auditorias } = servico();
    const r = await marcar({ uso: 'INTERNA', motivo: '  conta de demonstração  ' });
    assert.deepEqual(r, { uso: 'INTERNA', alterado: true });
    const sqls = banco.executados.map((e) => e.sql);
    const trava = sqls.findIndex((s) => /FOR UPDATE OF e/.test(s));
    const grava = sqls.findIndex((s) => /INSERT INTO plataforma_empresas_uso/.test(s));
    assert.ok(trava >= 0 && grava > trava, 'trava antes de gravar');
    assert.match(sqls[grava], /ON CONFLICT \(empresa_id\) DO UPDATE/);
    assert.deepEqual(banco.executados[grava].params, [EMPRESA, 'INTERNA', sessao.usuario_id]);
    assert.equal(auditorias.length, 1);
    const a = auditorias[0] as Record<string, unknown>;
    assert.equal(a.acao, 'EMPRESA_USO_ALTERADO');
    assert.equal(a.entidadeId, EMPRESA);
    assert.deepEqual(a.dadosAntes, { uso: 'CLIENTE' });
    assert.equal((a.dadosDepois as Record<string, unknown>).uso, 'INTERNA');
    assert.equal((a.dadosDepois as Record<string, unknown>).empresaId, EMPRESA);
    assert.equal(a.justificativa, 'conta de demonstração');
});

test('marcar o que já está: nada grava nem audita', async () => {
    const { marcar, banco, auditorias } = servico({ usoAtual: 'INTERNA' });
    assert.deepEqual(await marcar({ uso: 'INTERNA', motivo: 'de novo' }), { uso: 'INTERNA', alterado: false });
    assert.ok(!banco.executados.some((e) => /INSERT INTO plataforma_empresas_uso/.test(e.sql)));
    assert.equal(auditorias.length, 0);
    const volta = servico({ usoAtual: null });
    assert.deepEqual(await volta.marcar({ uso: 'CLIENTE', motivo: 'já é cliente' }), { uso: 'CLIENTE', alterado: false });
    assert.equal(volta.auditorias.length, 0);
});

test('entrada recusada: uso fora da lista, motivo curto, campo a mais, id inválido', async () => {
    const { marcar, banco } = servico();
    await assert.rejects(marcar({ uso: 'TESTE', motivo: 'qualquer' }));
    await assert.rejects(marcar({ uso: 'INTERNA', motivo: '  a ' }));
    await assert.rejects(marcar({ uso: 'INTERNA', motivo: 'motivo ok', empresaId: 'x' }));
    await assert.rejects(marcar({ uso: 'INTERNA', motivo: 'motivo ok' }, 'nao-e-uuid'));
    assert.equal(banco.executados.length, 0);
});
