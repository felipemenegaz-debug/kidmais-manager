import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { conectarDescartavel, encerrarDescartavel } from '../comercial/postgres-descartavel.ts';
import { carregarModulo } from '../acessos/teste-carregador.ts';

/**
 * #160 (R2) no PostgreSQL DESCARTÁVEL (modelo "063"), Perfis de id próprio: suspensão e reativação do vínculo.
 * S1–S5: as concessões de quem tem o vínculo suspenso ficam inertes (não são revogadas) e voltam a valer na reativação;
 * a proteção da última administradora acompanha nos dois sentidos. S6: remover um vínculo SUSPENSO revoga as concessões
 * do Perfil da pessoa. Cenários da sonda da revisão de 12/10/2026 (o S7, empresa SaaS suspensa, é limitação registrada).
 */
process.env.ADMIN_AUTH_SECRET = `segredo-sintetico-de-teste-${'x'.repeat(24)}`;
process.env.EMAIL_PROVIDER = 'desativado';

type Fn = (...args: unknown[]) => Promise<unknown>;
let client: Client;
const cache = new Map<string, Record<string, unknown>>();
const carregar = (f: string) => carregarModulo(f, { 'db/postgres': { db: () => client, withTransaction } }, cache) as Record<string, Fn>;
async function withTransaction<T>(work: (tx: Client) => Promise<T>): Promise<T> {
    await client.query('BEGIN');
    try { const r = await work(client); await client.query('COMMIT'); return r; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
}
const sufixo = randomBytes(3).toString('hex');
const ids: Record<string, string> = {};
const agora = () => Date.now();
const sessao = (usuarioId: string) => ({
    id: randomUUID(), usuario_id: usuarioId, nome: 'Pessoa', cargo: null, papel: 'ADMINISTRATIVO',
    autenticado_em: new Date(agora() - 60_000).toISOString(), consultado_em: new Date(agora()).toISOString(),
    expira_em: new Date(agora() + 3_600_000).toISOString(), csrf_hash: 'h',
});
const ctx = () => ({ requestId: randomUUID(), ip: null, userAgent: 'r2-suspensao' });
async function erro(p: Promise<unknown>) {
    try { await p; return 'OK'; }
    catch (e) { const x = e as { code?: string; httpStatus?: number; status?: number }; return `${x.code ?? 'SEM_CODIGO'}:${x.httpStatus ?? x.status ?? '?'}`; }
}
const statusDe = async (empresa: string, u: string) => (await client.query<{ status: string }>('SELECT status FROM memberships WHERE empresa_id=$1 AND usuario_id=$2', [empresa, u])).rows[0]?.status;
const ativas = async (perfil: string, u: string) => Number((await client.query("SELECT count(*)::int AS n FROM perfil_empresa_concessoes WHERE empresa_id=$1 AND usuario_id=$2 AND revogado_em IS NULL", [perfil, u])).rows[0].n);
const conceder = (perfil: string, u: string, cap = 'PERFIL_ADMINISTRAR_CONCESSOES') => client.query(
    "INSERT INTO perfil_empresa_concessoes (empresa_id, usuario_id, capacidade, concedido_por, motivo, referencia_autorizacao) VALUES ($1,$2,$3,$2,'fixture R2 suspensão','TESTE')", [perfil, u, cap]);

let vinculos: Record<string, Fn>, usuarios: Record<string, Fn>, deps: Record<string, unknown>;
let capacidades: (tx: Client, perfil: string, u: string) => Promise<{ gestaoAtiva: boolean; capacidades: Record<string, boolean> }>;
const painel = (acao: 'desativar' | 'reativar', empresa: string, u: string) => erro(vinculos.alterarSituacaoVinculo(sessao(ids.dev), empresa, u, acao, { motivo: 'Teste R2 suspensão' }, ctx(), deps));
const remover = (ator: string, empresa: string, u: string) => erro(usuarios.removerDaEmpresa(sessao(ator), { acao: 'remover', usuarioId: u, confirmar: true }, randomUUID(), undefined, empresa));
const administra = async (perfil: string, u: string) => { const c = await capacidades(client, perfil, u); return c.gestaoAtiva && c.capacidades.PERFIL_ADMINISTRAR_CONCESSOES; };

async function membership(empresa: string, u: string) {
    const m = (await client.query<{ id: string }>("INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde, papel) VALUES ($1,$2,'PENDENTE',clock_timestamp(),'REPRESENTANTE_AUTORIZADO') RETURNING id", [empresa, u])).rows[0].id;
    await client.query("UPDATE memberships SET status='ATIVA' WHERE id=$1", [m]);
}
async function empresaComPerfil(chave: string) {
    const codigo = `r2s-${chave.toLowerCase()}-${sufixo}`;
    ids[`empresa${chave}`] = (await client.query<{ id: string }>("INSERT INTO empresas (codigo, nome, status) VALUES ($1,$2,'PROVISIONAMENTO') RETURNING id", [codigo, `Buffet ${chave}`])).rows[0].id;
    await client.query("UPDATE empresas SET status='ATIVA' WHERE id=$1", [ids[`empresa${chave}`]]);
    ids[`perfil${chave}`] = (await client.query<{ id: string }>('INSERT INTO perfil_empresas (codigo, nome_comercial) VALUES ($1,$2) RETURNING id', [codigo, `Buffet ${chave}`])).rows[0].id;
}

test.before(async () => {
    client = await conectarDescartavel();
    vinculos = carregar('lib/desenvolvedor/vinculos.ts');
    usuarios = carregar('lib/autenticacao/usuarios.ts');
    capacidades = (carregar('lib/perfil/autorizacao.ts') as unknown as { consultarCapacidadesPerfil: typeof capacidades }).consultarCapacidadesPerfil;
    deps = { withTransaction, registrarAuditoria: carregar('lib/clientes/repositories/auditoria.repository.ts').registrarAuditoria, enviarEmail: async () => undefined, gerarToken: () => 'x' };
    const { criarHashSenha } = carregar('lib/autenticacao/senha.ts') as unknown as { criarHashSenha: (s: string) => Promise<string> };
    const hash = await criarHashSenha('senha-sintetica-r2-suspensao');
    for (const chave of ['dev', 'a', 'b', 'c'])
        ids[chave] = (await client.query<{ id: string }>('INSERT INTO usuarios_administrativos (email,nome,senha_hash,papel) VALUES ($1,$2,$3,$4) RETURNING id', [`r2s-${chave}-${sufixo}@exemplo.test`, `Pessoa ${chave}`, hash, 'ADMINISTRATIVO'])).rows[0].id;
    await client.query("INSERT INTO plataforma_desenvolvedores (usuario_id, concedido_por, motivo) VALUES ($1,'Teste R2','Desenvolvedor sintético R2 suspensão')", [ids.dev]);
    await empresaComPerfil('E');
    for (const u of [ids.a, ids.b, ids.c]) await membership(ids.empresaE, u);
    await conceder(ids.perfilE, ids.a);
    await conceder(ids.perfilE, ids.a, 'PERFIL_CONSULTAR');
    await conceder(ids.perfilE, ids.b);
});
test.after(async () => { if (client) await encerrarDescartavel(client); });

test('S1: desativar A (B também administra) segue; as concessões de A NÃO são revogadas, mas ficam inertes', async () => {
    assert.equal(await painel('desativar', ids.empresaE, ids.a), 'OK');
    assert.equal(await statusDe(ids.empresaE, ids.a), 'SUSPENSA');
    assert.equal(await ativas(ids.perfilE, ids.a), 2, 'concessões preservadas');
    assert.equal(await administra(ids.perfilE, ids.a), false, 'inertes durante a suspensão');
});

test('S2: com A suspensa, B é a única elegível: remover e desativar B são recusados (409)', async () => {
    assert.equal(await remover(ids.c, ids.empresaE, ids.b), 'PERFIL_ULTIMA_ADMINISTRADORA:409');
    assert.equal(await painel('desativar', ids.empresaE, ids.b), 'ULTIMA_ADMINISTRADORA:409');
    assert.equal(await statusDe(ids.empresaE, ids.b), 'ATIVA');
});

test('S3: reativar A devolve a elegibilidade (as mesmas concessões, sem nova concessão)', async () => {
    assert.equal(await painel('reativar', ids.empresaE, ids.a), 'OK');
    assert.equal(await statusDe(ids.empresaE, ids.a), 'ATIVA');
    assert.equal(await administra(ids.perfilE, ids.a), true);
    assert.equal(await ativas(ids.perfilE, ids.a), 2);
});

test('S4: com A de volta, desativar B passa a ser permitido; depois A é a única e não pode ser desativada', async () => {
    assert.equal(await painel('desativar', ids.empresaE, ids.b), 'OK');
    assert.equal(await painel('desativar', ids.empresaE, ids.a), 'ULTIMA_ADMINISTRADORA:409');
});

test('S5: a desativação e a reativação de A ficam auditadas (o registro das concessões que voltam a valer é backlog)', async () => {
    const acoes = (await client.query<{ acao: string }>(
        "SELECT acao FROM auditoria WHERE acao IN ('MEMBERSHIP_DESATIVADA','MEMBERSHIP_REATIVADA') AND dados_depois->>'usuarioId'=$1 ORDER BY criado_em", [ids.a])).rows.map((r) => r.acao);
    assert.deepEqual(acoes.slice(0, 2), ['MEMBERSHIP_DESATIVADA', 'MEMBERSHIP_REATIVADA']);
});

test('S6: remover B, que está SUSPENSA, revoga as concessões de B no Perfil E', async () => {
    assert.equal(await statusDe(ids.empresaE, ids.b), 'SUSPENSA');
    assert.equal(await remover(ids.c, ids.empresaE, ids.b), 'OK');
    assert.equal(await statusDe(ids.empresaE, ids.b), 'REVOGADA');
    assert.equal(await ativas(ids.perfilE, ids.b), 0);
});

