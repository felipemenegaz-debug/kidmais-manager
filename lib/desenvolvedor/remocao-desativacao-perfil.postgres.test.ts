import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { conectarDescartavel, encerrarDescartavel } from '../comercial/postgres-descartavel.ts';
import { carregarModulo } from '../acessos/teste-carregador.ts';

/**
 * R2 no PostgreSQL DESCARTÁVEL (modelo "063"): remover a pessoa da empresa (Configurações > Usuários) e desativar o
 * vínculo (painel do desenvolvedor) com Perfis de id PRÓPRIO, diferentes do id da empresa SaaS (associação por código,
 * como em lib/perfil/criacao.ts). Duas empresas, cada uma com o seu Perfil: a proteção da última administradora olha
 * só o Perfil da empresa, administradoras do outro Perfil não contam, a remoção revoga só as concessões da pessoa no
 * Perfil da empresa e a associação ambígua recusa sem alterar acessos.
 */
process.env.ADMIN_AUTH_SECRET = `segredo-sintetico-de-teste-${'x'.repeat(24)}`;
process.env.EMAIL_PROVIDER = 'desativado';

type Fn = (...args: unknown[]) => Promise<unknown>;
let client: Client;
const cache = new Map<string, Record<string, unknown>>();
const carregar = (f: string) => carregarModulo(f, { 'db/postgres': { db: () => client, withTransaction } }, cache) as Record<string, Fn>;

async function withTransaction<T>(work: (tx: Client) => Promise<T>): Promise<T> {
    await client.query('BEGIN');
    try {
        const r = await work(client);
        await client.query('COMMIT');
        return r;
    }
    catch (error) {
        await client.query('ROLLBACK');
        throw error;
    }
}

const sufixo = randomBytes(3).toString('hex');
const ids: Record<string, string> = {};
const agora = () => Date.now();
const sessao = (usuarioId: string) => ({
    id: randomUUID(), usuario_id: usuarioId, nome: 'Pessoa', cargo: null, papel: 'ADMINISTRATIVO',
    autenticado_em: new Date(agora() - 60_000).toISOString(), consultado_em: new Date(agora()).toISOString(),
    expira_em: new Date(agora() + 3_600_000).toISOString(), csrf_hash: 'h',
});
const ctx = () => ({ requestId: randomUUID(), ip: null, userAgent: 'teste-r2' });
async function erro(p: Promise<unknown>) {
    try {
        await p;
        return 'OK';
    }
    catch (e) {
        const x = e as { code?: string; httpStatus?: number; status?: number };
        return `${x.code ?? 'SEM_CODIGO'}:${x.httpStatus ?? x.status ?? '?'}`;
    }
}
const statusDe = async (empresa: string, usuarioId: string) =>
    (await client.query<{ status: string }>('SELECT status FROM memberships WHERE empresa_id = $1 AND usuario_id = $2', [empresa, usuarioId])).rows[0]?.status;
const conceder = (perfil: string, usuarioId: string, capacidade = 'PERFIL_ADMINISTRAR_CONCESSOES') => client.query(
    "INSERT INTO perfil_empresa_concessoes (empresa_id, usuario_id, capacidade, concedido_por, motivo, referencia_autorizacao) VALUES ($1, $2, $3, $2, 'fixture R2', 'TESTE')",
    [perfil, usuarioId, capacidade]);
/** Concessões ATIVAS, como "perfil:usuario:capacidade" ordenadas (só das pessoas da fixture). */
async function concessoesAtivas() {
    const r = await client.query<{ empresa_id: string; usuario_id: string; capacidade: string }>(
        'SELECT empresa_id, usuario_id, capacidade FROM perfil_empresa_concessoes WHERE revogado_em IS NULL AND empresa_id = ANY($1::uuid[]) ORDER BY 1, 2, 3',
        [[ids.perfilA, ids.perfilB]]);
    const nome = Object.fromEntries(Object.entries(ids).map(([k, v]) => [v, k]));
    return r.rows.map((l) => `${nome[l.empresa_id]}:${nome[l.usuario_id]}:${l.capacidade}`).sort();
}

let vinculos: Record<string, Fn>;
let usuarios: Record<string, Fn>;
let deps: Record<string, unknown>;
const desativarPeloPainel = (empresa: string, usuarioId: string) => erro(vinculos.alterarSituacaoVinculo(sessao(ids.dev), empresa, usuarioId, 'desativar', { motivo: 'Teste R2' }, ctx(), deps));
const removerPelaEmpresa = (ator: string, empresa: string, usuarioId: string) => erro(usuarios.removerDaEmpresa(sessao(ator), { acao: 'remover', usuarioId, confirmar: true }, randomUUID(), undefined, empresa));

async function membership(empresa: string, usuarioId: string) {
    const m = (await client.query<{ id: string }>("INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde, papel) VALUES ($1, $2, 'PENDENTE', clock_timestamp(), 'REPRESENTANTE_AUTORIZADO') RETURNING id", [empresa, usuarioId])).rows[0].id;
    await client.query("UPDATE memberships SET status = 'ATIVA' WHERE id = $1", [m]);
}

test.before(async () => {
    client = await conectarDescartavel();
    vinculos = carregar('lib/desenvolvedor/vinculos.ts');
    usuarios = carregar('lib/autenticacao/usuarios.ts');
    deps = { withTransaction, registrarAuditoria: carregar('lib/clientes/repositories/auditoria.repository.ts').registrarAuditoria, enviarEmail: async () => undefined, gerarToken: () => 'x' };
    const { criarHashSenha } = carregar('lib/autenticacao/senha.ts') as unknown as { criarHashSenha: (s: string) => Promise<string> };
    const hash = await criarHashSenha('senha-sintetica-r2');
    for (const chave of ['dev', 'alvo', 'outra', 'terceira', 'quarta'])
        ids[chave] = (await client.query<{ id: string }>('INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel) VALUES ($1, $2, $3, $4) RETURNING id',
            [`r2-${chave}-${sufixo}@exemplo.test`, `Pessoa ${chave}`, hash, 'ADMINISTRATIVO'])).rows[0].id;
    await client.query("INSERT INTO plataforma_desenvolvedores (usuario_id, concedido_por, motivo) VALUES ($1, 'Teste R2', 'Desenvolvedor sintético R2')", [ids.dev]);
    for (const [chave, codigo] of [['empresaA', `r2a-${sufixo}`], ['empresaB', `r2b-${sufixo}`]]) {
        ids[chave] = (await client.query<{ id: string }>("INSERT INTO empresas (codigo, nome, status) VALUES ($1, $2, 'PROVISIONAMENTO') RETURNING id", [codigo, `Buffet ${chave}`])).rows[0].id;
        await client.query("UPDATE empresas SET status = 'ATIVA' WHERE id = $1", [ids[chave]]);
        // Perfil com id PRÓPRIO (gen_random_uuid), associado à empresa SaaS pelo código, como em lib/perfil/criacao.ts.
        ids[chave.replace('empresa', 'perfil')] = (await client.query<{ id: string }>('INSERT INTO perfil_empresas (codigo, nome_comercial) VALUES ($1, $2) RETURNING id', [codigo, `Buffet ${chave}`])).rows[0].id;
    }
    // A: alvo e outra na Gestão; B: alvo, terceira e quarta na Gestão (a alvo em duas empresas; a quarta sem concessão no Perfil,
    // para que a guarda da última Gestão de B não se antecipe à do Perfil).
    for (const [empresa, usuario] of [[ids.empresaA, ids.alvo], [ids.empresaA, ids.outra], [ids.empresaB, ids.alvo], [ids.empresaB, ids.terceira], [ids.empresaB, ids.quarta]])
        await membership(empresa, usuario);
    // Perfil A: só a alvo administra (e também consulta). Perfil B: a alvo e a terceira administram; a outra é de B só
    // como concessão (administradora de OUTRO Perfil, que não pode contar para A).
    await conceder(ids.perfilA, ids.alvo);
    await conceder(ids.perfilA, ids.alvo, 'PERFIL_CONSULTAR');
    await conceder(ids.perfilB, ids.alvo);
    await conceder(ids.perfilB, ids.terceira);
    await conceder(ids.perfilB, ids.outra);
});
test.after(async () => { if (client) await encerrarDescartavel(client); });

test('fixture: cada Perfil tem id diferente da sua empresa SaaS e é o Perfil dela', async () => {
    const { perfilDoTenantOuNulo } = carregar('lib/perfil/tenant.ts') as unknown as { perfilDoTenantOuNulo: (tx: Client, e: string) => Promise<string | null> };
    for (const [empresa, perfil] of [[ids.empresaA, ids.perfilA], [ids.empresaB, ids.perfilB]]) {
        assert.notEqual(perfil, empresa);
        assert.equal(await perfilDoTenantOuNulo(client, empresa), perfil);
    }
});

test('painel: desativar o vínculo da única administradora do Perfil A → 409 ULTIMA_ADMINISTRADORA; vínculo e concessões intactos (as de B não contam)', async () => {
    const antes = await concessoesAtivas();
    assert.equal(await desativarPeloPainel(ids.empresaA, ids.alvo), 'ULTIMA_ADMINISTRADORA:409');
    assert.equal(await statusDe(ids.empresaA, ids.alvo), 'ATIVA');
    assert.deepEqual(await concessoesAtivas(), antes);
});

test('Configurações > Usuários: a outra Gestão remover a única administradora do Perfil A → 409 PERFIL_ULTIMA_ADMINISTRADORA; nada muda', async () => {
    const antes = await concessoesAtivas();
    assert.equal(await removerPelaEmpresa(ids.outra, ids.empresaA, ids.alvo), 'PERFIL_ULTIMA_ADMINISTRADORA:409');
    assert.equal(await statusDe(ids.empresaA, ids.alvo), 'ATIVA');
    assert.deepEqual(await concessoesAtivas(), antes);
});

test('associação ambígua (dois Perfis para a empresa A) → 409 nos dois fluxos, sem alterar acessos', async () => {
    // Segundo Perfil associado a A pelo mesmo id da empresa (EMPRESA_SAAS_DO_PERFIL: id = p.id).
    await client.query('INSERT INTO perfil_empresas (id, codigo, nome_comercial) VALUES ($1, $2, $3)', [ids.empresaA, `r2x-${sufixo}`, 'Ambíguo']);
    try {
        const antes = await concessoesAtivas();
        assert.equal(await desativarPeloPainel(ids.empresaA, ids.outra), 'PERFIL_ESTRUTURA_AUSENTE:409');
        assert.equal(await removerPelaEmpresa(ids.alvo, ids.empresaA, ids.outra), 'PERFIL_ESTRUTURA_AUSENTE:409');
        assert.equal(await statusDe(ids.empresaA, ids.outra), 'ATIVA');
        assert.deepEqual(await concessoesAtivas(), antes);
    }
    finally {
        await client.query('DELETE FROM perfil_empresas WHERE id = $1', [ids.empresaA]);
    }
});

test('remoção com outra administradora no Perfil A: revoga TODAS as concessões da pessoa no Perfil A, e só elas (Perfil B e outras pessoas intactos)', async () => {
    await conceder(ids.perfilA, ids.outra);
    assert.equal(await removerPelaEmpresa(ids.outra, ids.empresaA, ids.alvo), 'OK');
    assert.equal(await statusDe(ids.empresaA, ids.alvo), 'REVOGADA');
    assert.equal(await statusDe(ids.empresaB, ids.alvo), 'ATIVA', 'o vínculo em B continua');
    assert.deepEqual(await concessoesAtivas(), [
        'perfilA:outra:PERFIL_ADMINISTRAR_CONCESSOES',
        'perfilB:alvo:PERFIL_ADMINISTRAR_CONCESSOES',
        'perfilB:outra:PERFIL_ADMINISTRAR_CONCESSOES',
        'perfilB:terceira:PERFIL_ADMINISTRAR_CONCESSOES',
    ].sort());
    const revogadas = (await client.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM perfil_empresa_concessoes WHERE empresa_id = $1 AND usuario_id = $2 AND revogado_em IS NOT NULL AND motivo_revogacao = 'Acesso removido da empresa'",
        [ids.perfilA, ids.alvo])).rows[0].n;
    assert.equal(revogadas, 2);
    const auditoria = (await client.query<{ dados_depois: { concessoesPerfil?: number } }>(
        "SELECT dados_depois FROM auditoria WHERE acao = 'MEMBERSHIP_REMOVIDA' AND dados_depois->>'empresaId' = $1 ORDER BY criado_em DESC LIMIT 1", [ids.empresaA])).rows[0];
    assert.equal(auditoria?.dados_depois.concessoesPerfil, 2);
});

test('painel com outra administradora no Perfil B: desativar o vínculo da alvo em B segue (SUSPENSA) e não revoga concessões', async () => {
    const antes = await concessoesAtivas();
    assert.equal(await desativarPeloPainel(ids.empresaB, ids.alvo), 'OK');
    assert.equal(await statusDe(ids.empresaB, ids.alvo), 'SUSPENSA');
    assert.deepEqual(await concessoesAtivas(), antes);
});

test('painel: a terceira, agora única administradora ELEGÍVEL do Perfil B (a alvo está suspensa e a outra não é membro de B), não é desativada', async () => {
    assert.equal(await desativarPeloPainel(ids.empresaB, ids.terceira), 'ULTIMA_ADMINISTRADORA:409');
    assert.equal(await statusDe(ids.empresaB, ids.terceira), 'ATIVA');
});
