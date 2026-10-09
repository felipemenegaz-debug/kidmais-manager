import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
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
            if (resolvido.endsWith('/db/postgres.ts') || resolvido.endsWith('/auditoria.repository.ts') || resolvido.endsWith('/autenticacao/service.ts') || resolvido.endsWith('/autenticacao/senha.ts') || resolvido.endsWith('/autenticacao/papeis.ts') || resolvido.endsWith('/festas/perfis.ts') || resolvido.endsWith('/saas/provar-tenant.ts'))
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
        // As funções da plataforma (desativar) não passam pelo tenant.
        if (name.endsWith('/saas/provar-tenant.ts')) return { executarNoTenant: async () => { throw new Error('tenant não usado pela plataforma'); } };
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
        desativarUsuarioAdministrativo: (sessao: unknown, raw: unknown, requestId: string, deps?: unknown) => Promise<{ ativo: boolean; papel: string }>;
    };
}

const { desativarUsuarioAdministrativo } = carregar();

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

// ---------------------------------------------------------------------------------------------
// 056 — administração de contas NA EMPRESA: identidade global, membership por empresa.
// Modelo em memória que aplica os predicados da SQL (empresa no WHERE, status, papel da membership).
// ---------------------------------------------------------------------------------------------
type Identidade = { id: string; nome: string; email: string; papel: string; ativo: boolean; senha: string };
type Vinculo = { id: string; empresa: string; usuario: string; status: 'PENDENTE' | 'ATIVA' | 'REVOGADA'; papel: string };
type CapFesta = { id: string; empresa: string; membership: string; capacidade: string; revogada: boolean };
const EMP_A = '11111111-1111-4111-8111-111111111111';
const EMP_B = '22222222-2222-4222-8222-222222222222';

function mundo() {
    const gestaoA = { id: randomUUID(), nome: 'Gestão A', email: 'gestao.a@example.invalid', papel: 'REPRESENTANTE_AUTORIZADO', ativo: true, senha: 'x' };
    const membroA = { id: randomUUID(), nome: 'Membro A', email: 'membro.a@example.invalid', papel: 'ADMINISTRATIVO', ativo: true, senha: 'x' };
    const soB = { id: randomUUID(), nome: 'Só B', email: 'so.b@example.invalid', papel: 'ADMINISTRATIVO', ativo: true, senha: 'senha-de-b' };
    const compartilhado = { id: randomUUID(), nome: 'Compartilhado', email: 'comp@example.invalid', papel: 'REPRESENTANTE_AUTORIZADO', ativo: true, senha: 'senha-comp' };
    const gestaoB = { id: randomUUID(), nome: 'Gestão B', email: 'gestao.b@example.invalid', papel: 'REPRESENTANTE_AUTORIZADO', ativo: true, senha: 'x' };
    const inativa = { id: randomUUID(), nome: 'Inativa', email: 'inativa@example.invalid', papel: 'ADMINISTRATIVO', ativo: false, senha: 'senha-inativa' };
    const identidades: Identidade[] = [gestaoA, membroA, soB, compartilhado, gestaoB, inativa];
    const v = (empresa: string, usuario: string, papel: string, status: Vinculo['status'] = 'ATIVA'): Vinculo => ({ id: randomUUID(), empresa, usuario, status, papel });
    const vinculos: Vinculo[] = [
        v(EMP_A, gestaoA.id, 'REPRESENTANTE_AUTORIZADO'), v(EMP_A, membroA.id, 'ADMINISTRATIVO'), v(EMP_A, compartilhado.id, 'ADMINISTRATIVO'),
        v(EMP_B, soB.id, 'ADMINISTRATIVO'), v(EMP_B, compartilhado.id, 'REPRESENTANTE_AUTORIZADO'), v(EMP_B, gestaoB.id, 'REPRESENTANTE_AUTORIZADO'),
    ];
    const caps: CapFesta[] = [];
    /** 057: capability CONTRATO_ASSINAR_EMPRESA por membership (empresa + membership). */
    const assinaturas: Array<{ empresa: string; membership: string; revogada: boolean }> = [];
    const auditorias: Array<{ acao: string }> = [];
    const hashes: string[] = [];
    const sqls: string[] = [];
    const linha = (m: Vinculo) => { const u = identidades.find((i) => i.id === m.usuario)!; return { id: u.id, nome: u.nome, email: u.email, papel: m.papel, membership_id: m.id, status: m.status, pode_assinar: assinaturas.some((a) => a.membership === m.id && a.empresa === m.empresa && !a.revogada) }; };
    const tx = {
        query: async (sql: string, p: unknown[] = []) => {
            sqls.push(sql);
            const r = (rows: unknown[]) => ({ rows, rowCount: rows.length });
            if (sql.startsWith('SELECT id FROM empresas WHERE id=$1::uuid FOR UPDATE')) return r([{ id: p[0] }]);
            if (sql.includes('AS instalado074')) return r([{ instalado074: false }]);
            if (sql.includes('FROM memberships m JOIN usuarios_administrativos u ON u.id = m.usuario_id') && sql.includes('WHERE m.empresa_id = $1::uuid')) {
                return r(vinculos.filter((m) => m.empresa === p[0] && (p[1] === undefined || m.usuario === p[1])).map(linha));
            }
            if (sql.startsWith('SELECT id FROM usuarios_administrativos WHERE lower(btrim(email))')) {
                return r(identidades.filter((i) => i.email.toLowerCase() === String(p[0]).toLowerCase()).map(({ id }) => ({ id })));
            }
            if (sql.startsWith('INSERT INTO usuarios_administrativos')) {
                const nova = { id: randomUUID(), email: String(p[0]), nome: String(p[1]), senha: String(p[2]), papel: String(p[3]), ativo: true };
                identidades.push(nova);
                return r([{ id: nova.id }]);
            }
            if (sql.startsWith('INSERT INTO memberships')) {
                assert.ok(!vinculos.some((m) => m.empresa === p[0] && m.usuario === p[1]), 'unicidade (empresa, usuário)');
                const nova = v(String(p[0]), String(p[1]), String(p[2]), 'PENDENTE');
                vinculos.push(nova);
                return r([{ id: nova.id }]);
            }
            if (sql.startsWith("UPDATE memberships SET status = 'ATIVA'")) { const m = vinculos.find((x) => x.id === p[0] && x.empresa === p[1])!; m.status = 'ATIVA'; return r([]); }
            if (sql.startsWith("UPDATE memberships SET status = 'REVOGADA'")) { const m = vinculos.find((x) => x.id === p[0] && x.empresa === p[1])!; m.status = 'REVOGADA'; return r([]); }
            if (sql.startsWith('UPDATE memberships SET papel')) { const m = vinculos.find((x) => x.id === p[0] && x.empresa === p[1])!; m.papel = String(p[2]); return r([]); }
            if (sql.startsWith('INSERT INTO festa_membership_capacidades')) {
                if (!caps.some((c) => c.membership === p[1] && c.capacidade === p[2] && !c.revogada)) caps.push({ id: randomUUID(), empresa: String(p[0]), membership: String(p[1]), capacidade: String(p[2]), revogada: false });
                return r([]);
            }
            if (sql.startsWith('UPDATE festa_membership_capacidades')) {
                const afetadas = caps.filter((c) => c.membership === p[0] && !c.revogada);
                for (const c of afetadas) c.revogada = true;
                return r(afetadas.map((c) => ({ id: c.id })));
            }
            if (sql.startsWith('INSERT INTO empresa_membership_capacidades')) {
                assert.match(sql, /'CONTRATO_ASSINAR_EMPRESA'/);
                if (!assinaturas.some((a) => a.membership === p[1] && !a.revogada)) assinaturas.push({ empresa: String(p[0]), membership: String(p[1]), revogada: false });
                return r([]);
            }
            if (sql.startsWith('UPDATE empresa_membership_capacidades')) {
                assert.match(sql, /WHERE membership_id = \$1::uuid AND empresa_id = \$2::uuid AND capacidade = 'CONTRATO_ASSINAR_EMPRESA'/);
                const afetadas = assinaturas.filter((a) => a.membership === p[0] && a.empresa === p[1] && !a.revogada);
                for (const a of afetadas) a.revogada = true;
                return r(afetadas.map(() => ({ id: randomUUID() })));
            }
            if (sql.includes('SELECT count(*)::int AS n FROM memberships m JOIN usuarios_administrativos u')) {
                return r([{ n: vinculos.filter((m) => m.empresa === p[0] && m.usuario !== p[1] && m.status === 'ATIVA' && m.papel === 'REPRESENTANTE_AUTORIZADO').length }]);
            }
            if (sql.includes('set_config')) return r([]);
            if (sql.includes('to_regclass')) return r([{ empresas: null, concessoes: null }]);
            throw new Error('SQL não simulado: ' + sql.slice(0, 80));
        },
    };
    /** provarTenant real sobre o modelo: membership ATIVA da empresa pedida (ou a única); papel DA MEMBERSHIP. */
    const tenantDe = (usuario: string, empresa?: string | null) => {
        const ativas = vinculos.filter((m) => m.usuario === usuario && m.status === 'ATIVA' && identidades.find((i) => i.id === usuario)?.ativo);
        const m = empresa ? ativas.find((x) => x.empresa === empresa) : ativas.length === 1 ? ativas[0] : undefined;
        if (!m) throw new Falha('Tenant não comprovado.', 403);
        return { empresaComprovada: m.empresa, membershipId: m.id, usuarioId: usuario, papelAtual: m.papel };
    };
    const deps = {
        criarHashSenha: async (senha: string) => { hashes.push(senha); return 'hash:' + senha; },
        registrarAuditoria: async (input: { acao: string }) => { auditorias.push(input); return {}; },
        withTransaction: async (fn: (t: unknown) => unknown) => fn(tx),
        // Estes cenários exercitam a criação direta: ligada explicitamente, sem herdar USUARIOS_CRIACAO_DIRETA do
        // ambiente (o build do Render roda com a variável do serviço). A recusa com ela desligada é coberta em
        // lib/acessos/convites-empresa.test.ts e no teste abaixo.
        criacaoDireta: () => true,
    };
    return { identidades, vinculos, caps, assinaturas, auditorias, sqls, hashes, tenantDe, deps, gestaoA, membroA, soB, compartilhado, gestaoB, inativa };
}

let mundoAtual: ReturnType<typeof mundo> | null = null;
const tenantModulo = {
    executarNoTenant: async (_tx: unknown, s: { usuario_id: string }, empresa: string | null | undefined, work: (tx: unknown, t: unknown) => Promise<unknown>) => {
        const m = mundoAtual!;
        const t = m.tenantDe(s.usuario_id, empresa);
        return work(await m.deps.withTransaction(async (tx) => tx), t);
    },
};
modulos.clear();
const u056 = carregarArquivo('lib/autenticacao/usuarios.ts', (name: string) => {
    if (name.endsWith('/saas/provar-tenant.ts')) return tenantModulo;
    if (name === 'zod') return req('zod');
    if (name.endsWith('/db/postgres') || name.endsWith('/db/postgres.ts')) return { withTransaction: async (fn: (tx: unknown) => unknown) => fn({}) };
    if (name.includes('auditoria.repository')) return { registrarAuditoria: async () => ({}) };
    if (name.includes('service')) return { authError: (message: string, status = 401) => new Falha(message, status) };
    if (name.includes('senha')) return { senhaValida: (password: string) => [...password].length >= 8, criarHashSenha: async () => 'hash-padrao' };
    if (name.includes('papeis')) return { nomePapelSistema: (papel: string) => papel === 'REPRESENTANTE_AUTORIZADO' ? 'Gestão' : 'Equipe', papelDeNivel: (nivel: string) => nivel === 'GESTAO' ? 'REPRESENTANTE_AUTORIZADO' : 'ADMINISTRATIVO' };
    if (name.includes('festas/perfis')) return { perfis: { GESTAO: ['FESTA_CONSULTAR', 'FESTA_CRIAR', 'FESTA_OPERAR', 'FESTA_CORRIGIR', 'FESTA_CONFIGURAR_AREAS'], EQUIPE: ['FESTA_CONSULTAR', 'FESTA_OPERAR'] } };
    throw new Error('módulo não simulado: ' + name);
}) as Record<string, (...a: unknown[]) => Promise<Record<string, unknown>>>;

function comoSessao(usuario: { id: string }, papelGlobal = 'REPRESENTANTE_AUTORIZADO') {
    return sessao({ usuario_id: usuario.id, papel: papelGlobal });
}

test('056 Gestão é o papel DA MEMBERSHIP nesta empresa: Equipe em A é recusada mesmo sendo representante global', async () => {
    const m = (mundoAtual = mundo());
    // `compartilhado` é REPRESENTANTE na identidade e em B, mas Equipe em A.
    const s = comoSessao(m.compartilhado);
    for (const chamada of [
        () => u056.listarUsuariosAdministrativos(s, EMP_A, m.deps),
        () => u056.criarUsuarioAdministrativo(s, { acao: 'criar', nome: 'X', email: 'x@example.invalid', nivel: 'EQUIPE', senha: 'senha-longa-1', confirmacao: 'senha-longa-1' }, 'r', m.deps, EMP_A),
        () => u056.alterarPapelNaEmpresa(s, { acao: 'papel', usuarioId: m.membroA.id, nivel: 'GESTAO' }, 'r', m.deps, EMP_A),
        () => u056.removerDaEmpresa(s, { acao: 'remover', usuarioId: m.membroA.id, confirmar: true }, 'r', m.deps, EMP_A),
    ]) await assert.rejects(chamada, (e: unknown) => httpStatus(e) === 403);
    // Em B, onde a membership é de Gestão, a mesma pessoa lista B.
    const b = await u056.listarUsuariosAdministrativos(s, EMP_B, m.deps) as { usuarios: Array<{ id: string }> };
    assert.ok(b.usuarios.some((u) => u.id === m.soB.id));
});

test('056 listagem: A vê membro A e o compartilhado (com o papel de A), nunca quem é só de B', async () => {
    const m = (mundoAtual = mundo());
    const r = await u056.listarUsuariosAdministrativos(comoSessao(m.gestaoA), null, m.deps) as { usuarios: Array<{ id: string; email: string; papel: string; statusMembership: string }> };
    const ids = r.usuarios.map((u) => u.id);
    assert.ok(ids.includes(m.membroA.id));
    assert.ok(ids.includes(m.compartilhado.id));
    assert.ok(!ids.includes(m.soB.id) && !ids.includes(m.gestaoB.id), 'conta só de B não aparece');
    assert.ok(!r.usuarios.some((u) => u.email === m.soB.email), 'nenhum dado de B');
    assert.equal(r.usuarios.find((u) => u.id === m.compartilhado.id)!.papel, 'ADMINISTRATIVO', 'papel NESTA empresa, não o de B nem o global');
    assert.ok(m.sqls.every((sql) => !sql.includes('FROM usuarios_administrativos ORDER BY')), 'nenhuma lista global');
});

test('criação direta desligada (E1): o mesmo cenário recusa antes de calcular hash ou abrir transação', async () => {
    const m = (mundoAtual = mundo());
    const s = comoSessao(m.gestaoA);
    let transacoes = 0;
    const identidadesAntes = m.identidades.length;
    const deps = { ...m.deps, criacaoDireta: () => false, withTransaction: async () => { transacoes += 1; } };
    await assert.rejects(
        () => u056.criarUsuarioAdministrativo(s, { acao: 'criar', nome: 'Nova', email: 'nova@example.invalid', nivel: 'EQUIPE', senha: 'senha-longa-1', confirmacao: 'senha-longa-1' }, 'r', deps, EMP_A),
        (e: unknown) => (e as { httpStatus?: number }).httpStatus === 403 && (e as { code?: string }).code === 'CRIACAO_DIRETA_DESATIVADA');
    assert.deepEqual([m.hashes.length, transacoes, m.identidades.length], [0, 0, identidadesAntes]);
});

test('056 criação: e-mail novo gera identidade + membership ATIVA + capacidades da membership; conta já administrável', async () => {
    const m = (mundoAtual = mundo());
    const s = comoSessao(m.gestaoA);
    const antes = m.identidades.length;
    const novo = await u056.criarUsuarioAdministrativo(s, { acao: 'criar', nome: 'Nova', email: 'Nova@Example.invalid', nivel: 'EQUIPE', senha: 'senha-longa-1', confirmacao: 'senha-longa-1' }, 'r', m.deps, null) as { membershipId: string; statusMembership: string; reutilizado: boolean };
    assert.equal(m.identidades.length, antes + 1);
    assert.equal(novo.statusMembership, 'ATIVA');
    assert.equal(novo.reutilizado, false);
    const identidadeNova = m.identidades.find((i) => i.email === 'nova@example.invalid')!;
    const vinc = m.vinculos.filter((v) => v.usuario === identidadeNova.id);
    assert.deepEqual(vinc.map((v) => [v.empresa, v.status, v.papel]), [[EMP_A, 'ATIVA', 'ADMINISTRATIVO']], 'uma membership, só em A');
    assert.deepEqual(m.caps.filter((c) => c.membership === novo.membershipId).map((c) => c.capacidade).sort(), ['FESTA_CONSULTAR', 'FESTA_OPERAR']);
    assert.ok(m.caps.every((c) => c.empresa === EMP_A));
    assert.ok(!m.sqls.some((sql) => sql.includes('festa_usuario_capacidades')), 'nenhuma capacidade global');
    // Imediatamente administrável pela empresa criadora.
    await u056.alterarPapelNaEmpresa(s, { acao: 'papel', usuarioId: identidadeNova.id, nivel: 'GESTAO' }, 'r', m.deps, null);
    assert.equal(m.vinculos.find((v) => v.usuario === identidadeNova.id)!.papel, 'REPRESENTANTE_AUTORIZADO');
    assert.equal(identidadeNova.papel, 'ADMINISTRATIVO', 'promover na empresa não toca o papel global');
    await u056.removerDaEmpresa(s, { acao: 'remover', usuarioId: identidadeNova.id, confirmar: true }, 'r', m.deps, null);
    assert.equal(m.vinculos.find((v) => v.usuario === identidadeNova.id)!.status, 'REVOGADA');
});

test('056 criação: e-mail existente (de B) não duplica identidade nem muda senha/papel; cria só a membership de A; idempotente; removida não reabre', async () => {
    const m = (mundoAtual = mundo());
    const s = comoSessao(m.gestaoA);
    const antes = m.identidades.length;
    const corpo = { acao: 'criar', nome: 'Outro nome', email: m.soB.email.toUpperCase(), nivel: 'GESTAO', senha: 'senha-trocada-1', confirmacao: 'senha-trocada-1' };
    const r = await u056.criarUsuarioAdministrativo(s, corpo, 'r', m.deps, null) as { reutilizado: boolean; papel: string };
    assert.equal(m.identidades.length, antes, 'uma única identidade');
    assert.equal(r.papel, 'REPRESENTANTE_AUTORIZADO', 'papel NESTA empresa');
    const ident = m.identidades.find((i) => i.id === m.soB.id)!;
    assert.deepEqual([ident.senha, ident.nome, ident.papel], ['senha-de-b', 'Só B', 'ADMINISTRATIVO'], 'identidade intacta');
    assert.deepEqual(m.vinculos.filter((v) => v.usuario === m.soB.id).map((v) => [v.empresa, v.status, v.papel]).sort(), [[EMP_A, 'ATIVA', 'REPRESENTANTE_AUTORIZADO'], [EMP_B, 'ATIVA', 'ADMINISTRATIVO']].sort(), 'duas memberships distintas; B intacta');
    const again = await u056.criarUsuarioAdministrativo(s, corpo, 'r', m.deps, null) as { reutilizado: boolean };
    assert.equal(again.reutilizado, true);
    await u056.removerDaEmpresa(s, { acao: 'remover', usuarioId: m.soB.id, confirmar: true }, 'r', m.deps, null);
    await assert.rejects(() => u056.criarUsuarioAdministrativo(s, corpo, 'r', m.deps, null), (e: unknown) => httpStatus(e) === 409);
});

test('056 papel: alterar em A não muda B nem a identidade; última Gestão e o próprio papel protegidos', async () => {
    const m = (mundoAtual = mundo());
    const s = comoSessao(m.gestaoA);
    await u056.alterarPapelNaEmpresa(s, { acao: 'papel', usuarioId: m.compartilhado.id, nivel: 'GESTAO' }, 'r', m.deps, null);
    await u056.alterarPapelNaEmpresa(s, { acao: 'papel', usuarioId: m.compartilhado.id, nivel: 'EQUIPE' }, 'r', m.deps, null);
    assert.equal(m.vinculos.find((v) => v.usuario === m.compartilhado.id && v.empresa === EMP_B)!.papel, 'REPRESENTANTE_AUTORIZADO', 'B intacta');
    assert.equal(m.identidades.find((i) => i.id === m.compartilhado.id)!.papel, 'REPRESENTANTE_AUTORIZADO', 'identidade intacta');
    assert.ok(!m.sqls.some((sql) => /UPDATE usuarios_administrativos/.test(sql)), 'nenhuma escrita na identidade');
    await assert.rejects(() => u056.alterarPapelNaEmpresa(s, { acao: 'papel', usuarioId: m.gestaoA.id, nivel: 'EQUIPE' }, 'r', m.deps, null), (e: unknown) => httpStatus(e) === 403);
    await assert.rejects(() => u056.alterarPapelNaEmpresa(s, { acao: 'papel', usuarioId: m.soB.id, nivel: 'GESTAO' }, 'r', m.deps, null), (e: unknown) => httpStatus(e) === 404, 'conta só de B: não encontrada nesta empresa');
    // Rebaixar outra Gestão de A mantém quem administra (o próprio ator), e só muda a membership de A.
    await u056.alterarPapelNaEmpresa(s, { acao: 'papel', usuarioId: m.compartilhado.id, nivel: 'GESTAO' }, 'r', m.deps, null);
    await u056.alterarPapelNaEmpresa(s, { acao: 'papel', usuarioId: m.compartilhado.id, nivel: 'EQUIPE' }, 'r', m.deps, null);
    assert.equal(m.vinculos.filter((v) => v.empresa === EMP_A && v.status === 'ATIVA' && v.papel === 'REPRESENTANTE_AUTORIZADO').length, 1);
});

test('056 remover o compartilhado de A: A revogada (e capacidades de A), B ativa, identidade e sessões intactas', async () => {
    const m = (mundoAtual = mundo());
    const s = comoSessao(m.gestaoA);
    const vA = m.vinculos.find((v) => v.usuario === m.compartilhado.id && v.empresa === EMP_A)!;
    const vB = m.vinculos.find((v) => v.usuario === m.compartilhado.id && v.empresa === EMP_B)!;
    m.caps.push({ id: randomUUID(), empresa: EMP_A, membership: vA.id, capacidade: 'FESTA_OPERAR', revogada: false });
    m.caps.push({ id: randomUUID(), empresa: EMP_B, membership: vB.id, capacidade: 'FESTA_OPERAR', revogada: false });
    await u056.removerDaEmpresa(s, { acao: 'remover', usuarioId: m.compartilhado.id, confirmar: true }, 'r', m.deps, null);
    assert.equal(vA.status, 'REVOGADA');
    assert.equal(vB.status, 'ATIVA', 'acesso em B permanece');
    assert.equal(m.identidades.find((i) => i.id === m.compartilhado.id)!.ativo, true, 'identidade global ativa');
    assert.deepEqual(m.caps.map((c) => [c.empresa, c.revogada]).sort(), [[EMP_A, true], [EMP_B, false]].sort(), 'só a capacidade de A cai');
    assert.ok(!m.sqls.some((sql) => /sessoes_administrativas|UPDATE usuarios_administrativos/.test(sql)), 'sessões e identidade não são tocadas');
    // Acesso em A bloqueado (sem membership ATIVA), em B mantido.
    assert.throws(() => m.tenantDe(m.compartilhado.id, EMP_A));
    assert.equal(m.tenantDe(m.compartilhado.id, EMP_B).empresaComprovada, EMP_B);
    // Não remove a si mesmo; não remove quem é só de B; a última Gestão de A não sai.
    await assert.rejects(() => u056.removerDaEmpresa(s, { acao: 'remover', usuarioId: m.gestaoA.id, confirmar: true }, 'r', m.deps, null), (e: unknown) => httpStatus(e) === 403);
    await assert.rejects(() => u056.removerDaEmpresa(s, { acao: 'remover', usuarioId: m.soB.id, confirmar: true }, 'r', m.deps, null), (e: unknown) => httpStatus(e) === 404);
    assert.equal(m.vinculos.find((v) => v.usuario === m.soB.id)!.status, 'ATIVA');
});

// F1 — rota de tenant nunca cria autoridade de plataforma.
const plataforma = carregarArquivo('lib/autenticacao/plataforma.ts', () => { throw new Error('plataforma.ts não tem dependência'); }) as {
    temAutoridadeDePlataforma: (s: { papel: string }) => boolean; PAPEL_GLOBAL_NEUTRO: string; PAPEL_PLATAFORMA: string;
};

test('F1 admin de A cria Gestão: membership de A é Gestão, identidade global nasce neutra (sem plataforma) e a conta opera em A', async () => {
    const m = (mundoAtual = mundo());
    const s = comoSessao(m.gestaoA);
    await u056.criarUsuarioAdministrativo(s, { acao: 'criar', nome: 'Nova Gestão', email: 'nova.gestao@example.invalid', nivel: 'GESTAO', senha: 'senha-longa-1', confirmacao: 'senha-longa-1' }, 'r', m.deps, EMP_A);
    const ident = m.identidades.find((i) => i.email === 'nova.gestao@example.invalid')!;
    assert.equal(ident.papel, plataforma.PAPEL_GLOBAL_NEUTRO, 'identidade global neutra');
    assert.equal(ident.papel, 'ADMINISTRATIVO');
    assert.equal(plataforma.temAutoridadeDePlataforma({ papel: ident.papel }), false, 'sem autoridade de plataforma');
    assert.deepEqual(m.vinculos.filter((v) => v.usuario === ident.id).map((v) => [v.empresa, v.status, v.papel]), [[EMP_A, 'ATIVA', 'REPRESENTANTE_AUTORIZADO']]);
    assert.ok(m.sqls.filter((sql) => sql.startsWith('INSERT INTO usuarios_administrativos')).length === 1);
    assert.ok(!m.sqls.some((sql) => /UPDATE usuarios_administrativos/.test(sql)), 'nenhuma rota de tenant altera a identidade');
    // Opera em A pela membership: a prova de tenant devolve Gestão e ela administra a empresa.
    assert.equal(m.tenantDe(ident.id, EMP_A).papelAtual, 'REPRESENTANTE_AUTORIZADO');
    const lista = await u056.listarUsuariosAdministrativos(comoSessao(ident, ident.papel), EMP_A, m.deps) as { usuarios: Array<{ email: string }> };
    assert.ok(lista.usuarios.some((u) => u.email === m.membroA.email));
    // Mesmo com Gestão na empresa, a sessão (papel global) continua sem plataforma.
    assert.equal(plataforma.temAutoridadeDePlataforma(comoSessao(ident, ident.papel)), false);
    // Promover/rebaixar na empresa nunca escreve o papel global.
    await u056.alterarPapelNaEmpresa(s, { acao: 'papel', usuarioId: m.membroA.id, nivel: 'GESTAO' }, 'r', m.deps, EMP_A);
    assert.equal(m.identidades.find((i) => i.id === m.membroA.id)!.papel, 'ADMINISTRATIVO');
});

test('F2 criação por e-mail: mesma resposta para e-mail novo, de outra empresa, desta empresa e identidade inativa; sem id, nome, situação ou vínculos externos', async () => {
    const m = (mundoAtual = mundo());
    const s = comoSessao(m.gestaoA);
    const corpo = (email: string) => ({ acao: 'criar', nome: 'Nome digitado', email, nivel: 'EQUIPE', senha: 'senha-longa-1', confirmacao: 'senha-longa-1' });
    const novo = await u056.criarUsuarioAdministrativo(s, corpo('nunca.visto@example.invalid'), 'r', m.deps, EMP_A) as Record<string, unknown>;
    const deB = await u056.criarUsuarioAdministrativo(s, corpo(m.soB.email), 'r', m.deps, EMP_A) as Record<string, unknown>;
    const inativa = await u056.criarUsuarioAdministrativo(s, corpo(m.inativa.email), 'r', m.deps, EMP_A) as Record<string, unknown>;
    const desta = await u056.criarUsuarioAdministrativo(s, corpo(m.membroA.email), 'r', m.deps, EMP_A) as Record<string, unknown>;
    const chaves = ['associado', 'email', 'membershipId', 'nivelSistema', 'papel', 'reutilizado', 'statusMembership'];
    for (const resposta of [novo, deB, inativa, desta]) {
        assert.deepEqual(Object.keys(resposta).sort(), chaves, 'mesmo formato em todos os casos');
        const texto = JSON.stringify(resposta);
        for (const proibido of [m.soB.id, m.inativa.id, m.membroA.id, 'Só B', 'Inativa', 'Membro A', EMP_B, 'senha', 'hash'])
            assert.ok(!texto.includes(proibido), 'nada da identidade global nem de outra empresa: ' + proibido);
    }
    assert.deepEqual([novo.reutilizado, deB.reutilizado, inativa.reutilizado], [false, false, false], 'novo, de B e inativa: indistinguíveis');
    assert.equal(desta.reutilizado, true, 'só o que é desta empresa (membership já ativa aqui)');
    // Mesmo custo e mesmas recusas: a senha é validada e o hash calculado antes de saber se o e-mail existe.
    assert.equal(m.hashes.length, 4, 'hash calculado nos quatro casos');
    for (const email of ['outro.novo@example.invalid', m.soB.email, m.inativa.email]) {
        await assert.rejects(() => u056.criarUsuarioAdministrativo(s, { ...corpo(email), confirmacao: 'diferente-1' }, 'r', m.deps, EMP_A), (e: unknown) => httpStatus(e) === 400);
        await assert.rejects(() => u056.criarUsuarioAdministrativo(s, { ...corpo(email), senha: 'curta', confirmacao: 'curta' }, 'r', m.deps, EMP_A), (e: unknown) => httpStatus(e) === 400);
    }
    // Identidade inativa continua inativa e sem acesso; nada de B muda; B não aparece na listagem de A.
    assert.equal(m.inativa.ativo, false);
    assert.throws(() => m.tenantDe(m.inativa.id, EMP_A));
    assert.equal(m.vinculos.find((v) => v.usuario === m.soB.id && v.empresa === EMP_B)!.status, 'ATIVA');
    const lista = await u056.listarUsuariosAdministrativos(s, EMP_A, m.deps) as { usuarios: Array<Record<string, unknown>> };
    assert.ok(!JSON.stringify(lista).includes(EMP_B), 'nenhuma membership de outra empresa exposta');
    assert.ok(lista.usuarios.every((u) => !('identidade_ativa' in u)), 'situação global não é exposta');
    assert.equal(lista.usuarios.find((u) => u.email === m.inativa.email)!.ativo, true, 'situação exibida = a da membership desta empresa');
});

// 057 — assinar contratos pela empresa: capability da membership, nunca o papel global.
test('057 assinatura: Gestão de A concede e retira só na membership de A; Equipe não recebe; B e identidade intactas; sem plataforma', async () => {
    const m = (mundoAtual = mundo());
    const s = comoSessao(m.gestaoA);
    const vA = m.vinculos.find((v) => v.usuario === m.compartilhado.id && v.empresa === EMP_A)!;
    const vB = m.vinculos.find((v) => v.usuario === m.compartilhado.id && v.empresa === EMP_B)!;
    // compartilhado é Equipe em A: não recebe (assinar pela empresa exige Gestão nesta empresa).
    await assert.rejects(() => u056.alterarAssinaturaNaEmpresa(s, { acao: 'assinatura', usuarioId: m.compartilhado.id, conceder: true }, 'r', m.deps, EMP_A), (e: unknown) => httpStatus(e) === 409);
    await u056.alterarPapelNaEmpresa(s, { acao: 'papel', usuarioId: m.compartilhado.id, nivel: 'GESTAO' }, 'r', m.deps, EMP_A);
    const r = await u056.alterarAssinaturaNaEmpresa(s, { acao: 'assinatura', usuarioId: m.compartilhado.id, conceder: true }, 'r', m.deps, EMP_A) as { podeAssinar: boolean };
    assert.equal(r.podeAssinar, true);
    assert.deepEqual(m.assinaturas.filter((a) => !a.revogada).map((a) => [a.empresa, a.membership]), [[EMP_A, vA.id]], 'só a membership de A');
    assert.ok(!m.assinaturas.some((a) => a.membership === vB.id), 'B intacta');
    assert.equal(m.identidades.find((i) => i.id === m.compartilhado.id)!.papel, 'REPRESENTANTE_AUTORIZADO', 'papel global não muda');
    assert.ok(!m.sqls.some((sql) => /UPDATE usuarios_administrativos/.test(sql)));
    assert.equal(plataforma.temAutoridadeDePlataforma({ papel: plataforma.PAPEL_GLOBAL_NEUTRO }), false, 'capability não é plataforma');
    // Idempotente; listagem mostra; conta só de B não é encontrada em A.
    assert.equal((await u056.alterarAssinaturaNaEmpresa(s, { acao: 'assinatura', usuarioId: m.compartilhado.id, conceder: true }, 'r', m.deps, EMP_A) as { reutilizado: boolean }).reutilizado, true);
    const lista = await u056.listarUsuariosAdministrativos(s, EMP_A, m.deps) as { usuarios: Array<{ id: string; podeAssinar: boolean }> };
    assert.equal(lista.usuarios.find((u) => u.id === m.compartilhado.id)!.podeAssinar, true);
    assert.equal(lista.usuarios.find((u) => u.id === m.membroA.id)!.podeAssinar, false);
    await assert.rejects(() => u056.alterarAssinaturaNaEmpresa(s, { acao: 'assinatura', usuarioId: m.soB.id, conceder: true }, 'r', m.deps, EMP_A), (e: unknown) => httpStatus(e) === 404);
    // Quem é Equipe em A (membroA) não administra: não concede nem a si mesmo.
    await assert.rejects(() => u056.alterarAssinaturaNaEmpresa(comoSessao(m.membroA), { acao: 'assinatura', usuarioId: m.membroA.id, conceder: true }, 'r', m.deps, EMP_A), (e: unknown) => httpStatus(e) === 403);
    // Rebaixar para Equipe retira a assinatura; retirar direto também.
    await u056.alterarPapelNaEmpresa(s, { acao: 'papel', usuarioId: m.compartilhado.id, nivel: 'EQUIPE' }, 'r', m.deps, EMP_A);
    assert.ok(m.assinaturas.every((a) => a.revogada), 'rebaixamento revoga');
    assert.ok(m.auditorias.some((a) => a.acao === 'CONTRATO_ASSINATURA_CONCEDIDA'));
});

test('057 assinatura: remover da empresa revoga a assinatura daquela membership; a de B continua', async () => {
    const m = (mundoAtual = mundo());
    const s = comoSessao(m.gestaoA);
    const vA = m.vinculos.find((v) => v.usuario === m.compartilhado.id && v.empresa === EMP_A)!;
    const vB = m.vinculos.find((v) => v.usuario === m.compartilhado.id && v.empresa === EMP_B)!;
    await u056.alterarPapelNaEmpresa(s, { acao: 'papel', usuarioId: m.compartilhado.id, nivel: 'GESTAO' }, 'r', m.deps, EMP_A);
    await u056.alterarAssinaturaNaEmpresa(s, { acao: 'assinatura', usuarioId: m.compartilhado.id, conceder: true }, 'r', m.deps, EMP_A);
    m.assinaturas.push({ empresa: EMP_B, membership: vB.id, revogada: false });
    await u056.removerDaEmpresa(s, { acao: 'remover', usuarioId: m.compartilhado.id, confirmar: true }, 'r', m.deps, EMP_A);
    assert.equal(m.assinaturas.find((a) => a.membership === vA.id)!.revogada, true, 'A revogada');
    assert.equal(m.assinaturas.find((a) => a.membership === vB.id)!.revogada, false, 'B mantida');
    // Retirar diretamente: a própria Gestão pode retirar a de outra Gestão.
    const m2 = (mundoAtual = mundo());
    const s2 = comoSessao(m2.gestaoA);
    await u056.alterarAssinaturaNaEmpresa(s2, { acao: 'assinatura', usuarioId: m2.gestaoA.id, conceder: true }, 'r', m2.deps, EMP_A);
    assert.equal(m2.assinaturas.filter((a) => !a.revogada).length, 1, 'a Gestão pode habilitar a si mesma (a empresa não fica sem quem assine)');
    await u056.alterarAssinaturaNaEmpresa(s2, { acao: 'assinatura', usuarioId: m2.gestaoA.id, conceder: false }, 'r', m2.deps, EMP_A);
    assert.ok(m2.assinaturas.every((a) => a.revogada));
});

// PLATAFORMA — desativação da identidade global (não exposta a rota de tenant).
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
                if (sql.includes('FROM public.perfil_empresas') && !sql.includes('FOR UPDATE OF c'))
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
