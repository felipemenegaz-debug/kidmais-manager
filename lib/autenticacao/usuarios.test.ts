import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import ts from 'typescript';
import { nomePapelSistema, papelDeNivel } from './papeis.ts';
import { perfis } from '../festas/perfis.ts';

class Falha extends Error {
    httpStatus: number;
    constructor(message: string, httpStatus = 400) {
        super(message);
        this.name = 'ClienteServiceError';
        this.httpStatus = httpStatus;
    }
}

const req = createRequire(import.meta.url);

const modulos = new Map<string, Record<string, unknown>>();

function carregarArquivo(arquivo: string, exigir: (name: string) => unknown): Record<string, unknown> {
    const existente = modulos.get(arquivo);
    if (existente)
        return existente;
    const exports: Record<string, unknown> = {};
    modulos.set(arquivo, exports);
    const code = ts.transpileModule(readFileSync(arquivo, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const diretorio = path.dirname(arquivo);
    new Function('require', 'exports', code)((name: string) => {
        if (name.startsWith('node:'))
            return req(name);
        if (name.startsWith('.')) {
            const resolvido = path.normalize(path.join(diretorio, name.endsWith('.ts') ? name : `${name}.ts`)).replace(/\\/g, '/');
            if (resolvido.endsWith('/db/postgres.ts') || resolvido.endsWith('/auditoria.repository.ts') || resolvido.endsWith('/autenticacao/service.ts') || resolvido.endsWith('/autenticacao/senha.ts') || resolvido.endsWith('/autenticacao/papeis.ts') || resolvido.endsWith('/festas/perfis.ts'))
                return exigir(resolvido);
            return carregarArquivo(resolvido, exigir);
        }
        return exigir(name);
    }, exports);
    return exports;
}

function carregar() {
    const exports = carregarArquivo('lib/autenticacao/usuarios.ts', (name: string) => {
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
        if (name.includes('festas/perfis'))
            return { perfis: { GESTAO: ['FESTA_CONSULTAR', 'FESTA_CRIAR', 'FESTA_OPERAR', 'FESTA_CORRIGIR', 'FESTA_CONFIGURAR_AREAS'], EQUIPE: ['FESTA_CONSULTAR', 'FESTA_OPERAR'] } };
        throw new Error('módulo não simulado: ' + name);
    });
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

test('criação valida senha e e-mail duplicado e grava papel administrativo separado das Festas', async () => {
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
                if (sql.includes('INSERT INTO festa_usuario_capacidades'))
                    return { rows: [] };
                throw new Error(sql);
            },
        }),
    });
    assert.equal(resultado.nivelSistema, 'Equipe');
    assert.equal(resultado.papel, 'ADMINISTRATIVO');
    assert.equal(auditorias[0]?.acao, 'ADMIN_CRIAR');
    assert.equal(auditorias[0]?.dadosDepois?.papel, 'ADMINISTRATIVO');
    assert.equal(auditorias[1]?.acao, 'FESTA_PERFIL_APLICADO');
    assert.equal(sqls.filter((sql) => sql.includes('INSERT INTO festa_usuario_capacidades')).length, perfis.EQUIPE.length);
    assert.equal(sqls.some((sql) => sql.includes('perfil_empresa')), false);
    assert.equal(sqls.some((sql) => sql.includes('UPDATE usuarios_administrativos SET papel')), false);
});

test('criação aplica capacidades EQUIPE ou GESTAO e uma falha reverte a transação inteira', async () => {
    const atual = sessao();

    async function criar(nivel: 'EQUIPE' | 'GESTAO', falharNaCapacidade?: string) {
        const criadoId = randomUUID();
        const estado = {
            usuarios: [] as string[],
            capacidades: [] as string[],
            auditorias: [] as string[],
        };
        const deps = {
            criarHashSenha: async () => 'hash-sintetico',
            registrarAuditoria: async (input: { acao: string }) => { estado.auditorias.push(input.acao); return {}; },
            withTransaction: async (fn: (tx: unknown) => unknown) => {
                try {
                    return await fn({
                        query: async (sql: string, params?: unknown[]) => {
                            if (sql.includes('SELECT id FROM usuarios_administrativos WHERE email'))
                                return { rows: [] };
                            if (sql.includes('INSERT INTO usuarios_administrativos')) {
                                estado.usuarios.push(String(params?.[3]));
                                return { rows: [{ id: criadoId, nome: 'Nova', email: 'nova@example.invalid', papel: params?.[3], ativo: true }] };
                            }
                            if (sql.includes('INSERT INTO festa_usuario_capacidades')) {
                                const capacidade = String(params?.[1]);
                                if (falharNaCapacidade && capacidade === falharNaCapacidade)
                                    throw new Error('falha sintética na concessão');
                                estado.capacidades.push(capacidade);
                                return { rows: [] };
                            }
                            throw new Error(sql);
                        },
                    });
                } catch (error) {
                    estado.usuarios.length = 0;
                    estado.capacidades.length = 0;
                    estado.auditorias.length = 0;
                    throw error;
                }
            },
        };
        const resultado = await criarUsuarioAdministrativo(atual, {
            acao: 'criar', nome: 'Nova', email: `nova-${nivel.toLowerCase()}@example.invalid`, nivel, senha: 'aaaaaaaa', confirmacao: 'aaaaaaaa',
        }, 'req-' + nivel, deps).then(
            (ok: { papel: string }) => ({ estado, ok, error: null as Error | null }),
            (error: unknown) => ({ estado, ok: null as { papel: string } | null, error: error instanceof Error ? error : new Error(String(error)) }),
        );
        return resultado;
    }

    const equipe = await criar('EQUIPE');
    assert.equal(equipe.ok?.papel, 'ADMINISTRATIVO');
    assert.deepEqual(equipe.estado.capacidades, [...perfis.EQUIPE]);
    assert.deepEqual(equipe.estado.auditorias, ['ADMIN_CRIAR', 'FESTA_PERFIL_APLICADO']);

    const gestao = await criar('GESTAO');
    assert.equal(gestao.ok?.papel, 'REPRESENTANTE_AUTORIZADO');
    assert.deepEqual(gestao.estado.capacidades, [...perfis.GESTAO]);
    assert.notDeepEqual(gestao.estado.capacidades, [...perfis.EQUIPE]);

    const falha = await criar('GESTAO', 'FESTA_CORRIGIR');
    assert.match(String(falha.error), /falha sintética na concessão/);
    assert.deepEqual(falha.estado.usuarios, []);
    assert.deepEqual(falha.estado.capacidades, []);
    assert.deepEqual(falha.estado.auditorias, []);
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
                if (sql.includes('to_regclass'))
                    return { rows: [{ empresas: null, concessoes: null }] };
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

test('desativar a última administradora do perfil recusa sem alterar a conta', async () => {
    const atual = sessao();
    const empresaId = randomUUID();
    const alvo = { id: randomUUID(), nome: 'Titular', email: 'titular@example.invalid', papel: 'REPRESENTANTE_AUTORIZADO', ativo: true };
    const sqls: string[] = [];
    const auditorias: string[] = [];
    await assert.rejects(() => desativarUsuarioAdministrativo(atual, { acao: 'desativar', usuarioId: alvo.id, confirmar: true }, 'req-ultima', {
        criarHashSenha: async () => 'hash',
        registrarAuditoria: async (input: { acao: string }) => { auditorias.push(input.acao); return {}; },
        withTransaction: async (fn: (tx: unknown) => unknown) => fn({
            query: async (sql: string, params?: unknown[]) => {
                sqls.push(sql);
                if (sql.includes('to_regclass'))
                    return { rows: [{ empresas: 'perfil_empresas', concessoes: 'perfil_empresa_concessoes' }] };
                if (sql.includes('FROM public.perfil_empresas'))
                    return { rows: [{ id: empresaId }] };
                if (sql.includes('pg_advisory_xact_lock'))
                    return { rows: [] };
                if (sql.includes('FOR UPDATE OF c'))
                    return { rows: [{ empresa_id: empresaId, usuario_id: alvo.id, papel: 'REPRESENTANTE_AUTORIZADO', ativo: true }] };
                if (sql.includes('FOR UPDATE') && sql.includes('usuarios_administrativos'))
                    return { rows: [alvo] };
                throw new Error(sql + String(params));
            },
        }),
    }), (error: unknown) => typeof error === 'object' && error !== null && 'httpStatus' in error && error.httpStatus === 409);
    assert.deepEqual(auditorias, ['PERFIL_REVOGACAO_RECUSADA']);
    assert.equal(sqls.some((sql) => sql.includes('SET ativo=false')), false);
    assert.equal(sqls.some((sql) => sql.includes('sessoes_administrativas')), false);
    assert.equal(alvo.ativo, true);
});
