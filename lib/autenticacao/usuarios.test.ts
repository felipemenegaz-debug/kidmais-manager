import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import ts from 'typescript';
import { nomePapelSistema, papelDeNivel } from './papeis.ts';

class Falha extends Error {
    httpStatus: number;
    constructor(message: string, httpStatus = 400) {
        super(message);
        this.name = 'ClienteServiceError';
        this.httpStatus = httpStatus;
    }
}

const req = createRequire(import.meta.url);

function carregar() {
    const exports: Record<string, unknown> = {};
    const code = ts.transpileModule(readFileSync('lib/autenticacao/usuarios.ts', 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    new Function('require', 'exports', code)((name: string) => {
        if (name === 'zod') return req('zod');
        if (name.endsWith('/db/postgres') || name.endsWith('/db/postgres.ts'))
            return { withTransaction: async (fn: (tx: unknown) => unknown) => fn({}) };
        if (name.includes('auditoria.repository'))
            return { registrarAuditoria: async () => ({}) };
        if (name.includes('service'))
            return {
                authError: (message: string, status = 401) => new Falha(message, status),
            };
        if (name.includes('senha'))
            return {
                senhaValida: (password: string) => [...password].length >= 8 && [...password].length <= 128 && Buffer.byteLength(password) <= 512,
                criarHashSenha: async () => 'hash-padrao',
            };
        if (name.includes('papeis'))
            return { nomePapelSistema: (papel: string) => papel === 'REPRESENTANTE_AUTORIZADO' ? 'Gestão' : 'Equipe', papelDeNivel: (nivel: string) => nivel === 'GESTAO' ? 'REPRESENTANTE_AUTORIZADO' : 'ADMINISTRATIVO' };
        throw new Error('módulo não simulado: ' + name);
    }, exports);
    return exports as {
        listarUsuariosAdministrativos: (sessao: unknown, tx: unknown) => Promise<{ usuarioId: string; usuarios: Array<{ nivelSistema: string; ativo: boolean }> }>;
        criarUsuarioAdministrativo: (sessao: unknown, raw: unknown, requestId: string, deps?: unknown) => Promise<{ nivelSistema: string; papel: string }>;
        desativarUsuarioAdministrativo: (sessao: unknown, raw: unknown, requestId: string, deps?: unknown) => Promise<{ ativo: boolean; papel: string }>;
    };
}

const { listarUsuariosAdministrativos, criarUsuarioAdministrativo, desativarUsuarioAdministrativo } = carregar();

function sessao(overrides: Record<string, unknown> = {}) {
    return {
        id: randomUUID(),
        usuario_id: randomUUID(),
        nome: 'Gestão',
        cargo: null,
        papel: 'REPRESENTANTE_AUTORIZADO',
        autenticado_em: new Date().toISOString(),
        expira_em: new Date().toISOString(),
        csrf_hash: 'a'.repeat(64),
        ...overrides,
    };
}

function httpStatus(error: unknown) {
    return error instanceof Falha ? error.httpStatus : 0;
}

test('papel de sistema Gestão e Equipe não se confundem com códigos internos', () => {
    assert.equal(nomePapelSistema('REPRESENTANTE_AUTORIZADO'), 'Gestão');
    assert.equal(nomePapelSistema('ADMINISTRATIVO'), 'Equipe');
    assert.equal(papelDeNivel('GESTAO'), 'REPRESENTANTE_AUTORIZADO');
    assert.equal(papelDeNivel('EQUIPE'), 'ADMINISTRATIVO');
});

test('somente Gestão lista, cria e desativa usuários', async () => {
    const equipe = sessao({ papel: 'ADMINISTRATIVO' });
    const tx = { query: async () => ({ rows: [] }) };
    await assert.rejects(() => listarUsuariosAdministrativos(equipe, tx), (error: unknown) => httpStatus(error) === 403);
    await assert.rejects(() => criarUsuarioAdministrativo(equipe, { acao: 'criar' }, 'req'), (error: unknown) => httpStatus(error) === 403);
    await assert.rejects(() => desativarUsuarioAdministrativo(equipe, { acao: 'desativar', usuarioId: randomUUID(), confirmar: true }, 'req'), (error: unknown) => httpStatus(error) === 403);
});

test('lista inclui contas ativas e desativadas', async () => {
    const atual = sessao();
    const data = await listarUsuariosAdministrativos(atual, {
        query: async () => ({
            rows: [
                { id: atual.usuario_id, nome: 'Ana', email: 'ana@example.invalid', papel: 'REPRESENTANTE_AUTORIZADO', ativo: true },
                { id: randomUUID(), nome: 'Beto', email: 'beto@example.invalid', papel: 'ADMINISTRATIVO', ativo: false },
            ],
        }),
    });
    assert.equal(data.usuarioId, atual.usuario_id);
    assert.equal(data.usuarios[0].nivelSistema, 'Gestão');
    assert.equal(data.usuarios[1].nivelSistema, 'Equipe');
    assert.equal(data.usuarios[1].ativo, false);
});

test('criação valida senha, e-mail duplicado e grava papel de sistema sem tocar Festas', async () => {
    const atual = sessao();
    await assert.rejects(
        () => criarUsuarioAdministrativo(atual, { acao: 'criar', nome: 'Ana', email: 'ana@example.invalid', nivel: 'EQUIPE', senha: 'aaaaaaaa', confirmacao: 'bbbbbbbb' }, 'req'),
        /não conferem/,
    );
    await assert.rejects(
        () => criarUsuarioAdministrativo(atual, { acao: 'criar', nome: 'Ana', email: 'ana@example.invalid', nivel: 'EQUIPE', senha: '1234567', confirmacao: '1234567' }, 'req'),
        /entre 8 e 128/,
    );

    const sqls: string[] = [];
    const auditorias: Array<{ acao: string; dadosDepois?: { papel?: string } }> = [];
    const criadoId = randomUUID();
    const resultado = await criarUsuarioAdministrativo(atual, {
        acao: 'criar', nome: 'Ana', email: 'Ana@Example.invalid', nivel: 'EQUIPE', senha: 'aaaaaaaa', confirmacao: 'aaaaaaaa',
    }, 'req-criar', {
        criarHashSenha: async () => 'hash-sintetico',
        registrarAuditoria: async (input: { acao: string; dadosDepois?: { papel?: string } }) => { auditorias.push(input); return {}; },
        withTransaction: async (fn: (tx: unknown) => unknown) => fn({
            query: async (sql: string, params?: unknown[]) => {
                sqls.push(sql);
                if (sql.includes('SELECT id FROM usuarios_administrativos WHERE email')) {
                    assert.equal(params?.[0], 'ana@example.invalid');
                    return { rows: [] };
                }
                if (sql.includes('INSERT INTO usuarios_administrativos')) {
                    assert.equal(params?.[3], 'ADMINISTRATIVO');
                    return { rows: [{ id: criadoId, nome: 'Ana', email: 'ana@example.invalid', papel: 'ADMINISTRATIVO', ativo: true }] };
                }
                throw new Error(sql);
            },
        }),
    });
    assert.equal(resultado.nivelSistema, 'Equipe');
    assert.equal(auditorias[0]?.acao, 'ADMIN_CRIAR');
    assert.equal(auditorias[0]?.dadosDepois?.papel, 'ADMINISTRATIVO');
    assert.equal(sqls.some((sql) => sql.includes('festa_usuario')), false);
});

test('desativar recusa a própria conta, exige confirmação, revoga sessões e preserva o registro', async () => {
    const atual = sessao();
    await assert.rejects(
        () => desativarUsuarioAdministrativo(atual, { acao: 'desativar', usuarioId: atual.usuario_id, confirmar: true }, 'req'),
        (error: unknown) => httpStatus(error) === 403 && String(error).includes('própria conta'),
    );
    await assert.rejects(() => desativarUsuarioAdministrativo(atual, { acao: 'desativar', usuarioId: randomUUID() }, 'req'));

    const alvo = { id: randomUUID(), nome: 'Beto', email: 'beto@example.invalid', papel: 'ADMINISTRATIVO', ativo: true };
    const sqls: string[] = [];
    const auditorias: Array<{ acao: string }> = [];
    const depois = await desativarUsuarioAdministrativo(atual, { acao: 'desativar', usuarioId: alvo.id, confirmar: true }, 'req-desativar', {
        criarHashSenha: async () => 'hash',
        registrarAuditoria: async (input: { acao: string }) => { auditorias.push(input); return {}; },
        withTransaction: async (fn: (tx: unknown) => unknown) => fn({
            query: async (sql: string) => {
                sqls.push(sql);
                if (sql.includes('SELECT id,nome,email,papel,ativo FROM usuarios_administrativos WHERE id=$1 FOR UPDATE'))
                    return { rows: [alvo] };
                if (sql.includes('UPDATE usuarios_administrativos SET ativo=false'))
                    return { rows: [{ ...alvo, ativo: false }] };
                if (sql.includes('UPDATE sessoes_administrativas SET revogado_em'))
                    return { rows: [] };
                throw new Error(sql);
            },
        }),
    });
    assert.equal(depois.ativo, false);
    assert.equal(depois.papel, 'ADMINISTRATIVO');
    assert.equal(auditorias[0]?.acao, 'ADMIN_DESATIVAR');
    assert.equal(sqls.some((sql) => sql.includes('DELETE FROM usuarios_administrativos')), false);
    assert.equal(sqls.some((sql) => sql.includes('revogado_em')), true);
});
