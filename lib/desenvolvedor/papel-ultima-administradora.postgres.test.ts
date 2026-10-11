import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { conectarDescartavel, encerrarDescartavel } from '../comercial/postgres-descartavel.ts';
import { carregarModulo } from '../acessos/teste-carregador.ts';

/**
 * #157 no PostgreSQL DESCARTÁVEL (modelo "063"): rebaixar Gestão → Equipe recusa a última administradora do Perfil
 * quando o Perfil tem id PRÓPRIO, diferente do id da empresa SaaS (associação por código, como os Perfis criados por
 * lib/perfil/criacao.ts). As concessões ficam em perfil_empresa_concessoes.empresa_id = id do Perfil; a proteção
 * precisa converter a empresa SaaS no Perfil (perfilDoTenantOuNulo). Painel do desenvolvedor e Configurações > Usuários.
 */
process.env.ADMIN_AUTH_SECRET = `segredo-sintetico-de-teste-${'x'.repeat(24)}`;
process.env.EMAIL_PROVIDER = 'desativado';

type Fn = (...args: never[]) => Promise<never>;
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
const papelDe = async (usuarioId: string) => (await client.query<{ papel: string }>('SELECT papel FROM memberships WHERE empresa_id = $1 AND usuario_id = $2', [ids.empresa, usuarioId])).rows[0]?.papel;
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
const administrar = (usuarioId: string) => client.query(
    "INSERT INTO perfil_empresa_concessoes (empresa_id, usuario_id, capacidade, concedido_por, motivo, referencia_autorizacao) VALUES ($1, $2, 'PERFIL_ADMINISTRAR_CONCESSOES', $2, 'fixture 157', 'TESTE')",
    [ids.perfil, usuarioId]);

let vinculos: Record<string, Fn>;
let usuarios: Record<string, Fn>;

test.before(async () => {
    client = await conectarDescartavel();
    vinculos = carregar('lib/desenvolvedor/vinculos.ts');
    usuarios = carregar('lib/autenticacao/usuarios.ts');
    const { criarHashSenha } = carregar('lib/autenticacao/senha.ts') as unknown as { criarHashSenha: (s: string) => Promise<string> };
    const hash = await criarHashSenha('senha-sintetica-157');
    for (const chave of ['dev', 'alvo', 'outra'])
        ids[chave] = (await client.query<{ id: string }>('INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel) VALUES ($1, $2, $3, $4) RETURNING id',
            [`p157-${chave}-${sufixo}@exemplo.test`, `Pessoa ${chave}`, hash, 'ADMINISTRATIVO'])).rows[0].id;
    await client.query("INSERT INTO plataforma_desenvolvedores (usuario_id, concedido_por, motivo) VALUES ($1, 'Teste 157', 'Desenvolvedor sintético 157')", [ids.dev]);
    ids.empresa = (await client.query<{ id: string }>("INSERT INTO empresas (codigo, nome, status) VALUES ($1, 'Buffet 157', 'PROVISIONAMENTO') RETURNING id", [`p157-${sufixo}`])).rows[0].id;
    await client.query("UPDATE empresas SET status = 'ATIVA' WHERE id = $1", [ids.empresa]);
    for (const usuario of [ids.alvo, ids.outra]) {
        const m = (await client.query<{ id: string }>("INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde, papel) VALUES ($1, $2, 'PENDENTE', clock_timestamp(), 'REPRESENTANTE_AUTORIZADO') RETURNING id", [ids.empresa, usuario])).rows[0].id;
        await client.query("UPDATE memberships SET status = 'ATIVA' WHERE id = $1", [m]);
    }
    // Perfil com id PRÓPRIO (gen_random_uuid), associado à empresa SaaS pelo código, como em lib/perfil/criacao.ts.
    ids.perfil = (await client.query<{ id: string }>('INSERT INTO perfil_empresas (codigo, nome_comercial) VALUES ($1, $2) RETURNING id', [`p157-${sufixo}`, 'Buffet 157'])).rows[0].id;
    await administrar(ids.alvo);
});
test.after(async () => { if (client) await encerrarDescartavel(client); });

test('fixture: o Perfil tem id diferente da empresa SaaS e é o Perfil desta empresa', async () => {
    assert.notEqual(ids.perfil, ids.empresa);
    const { perfilDoTenantOuNulo } = carregar('lib/perfil/tenant.ts') as unknown as { perfilDoTenantOuNulo: (tx: Client, e: string) => Promise<string | null> };
    assert.equal(await perfilDoTenantOuNulo(client, ids.empresa), ids.perfil);
    assert.equal(Number((await client.query("SELECT count(*)::int AS n FROM perfil_empresa_concessoes WHERE empresa_id = $1 AND capacidade = 'PERFIL_ADMINISTRAR_CONCESSOES' AND revogado_em IS NULL", [ids.perfil])).rows[0].n), 1);
});

test('painel do desenvolvedor: rebaixar a última administradora do Perfil (id próprio) → 409 ULTIMA_ADMINISTRADORA; papel inalterado', async () => {
    const deps = { withTransaction, registrarAuditoria: (carregar('lib/clientes/repositories/auditoria.repository.ts') as unknown as { registrarAuditoria: Fn }).registrarAuditoria, enviarEmail: async () => undefined, gerarToken: () => 'x' };
    const r = await erro((vinculos.alterarPapelVinculo as unknown as (...a: unknown[]) => Promise<unknown>)(sessao(ids.dev), ids.empresa, ids.alvo, { nivel: 'EQUIPE' }, { requestId: randomUUID(), ip: null, userAgent: 'teste-157' }, deps));
    assert.equal(r, 'ULTIMA_ADMINISTRADORA:409');
    assert.equal(await papelDe(ids.alvo), 'REPRESENTANTE_AUTORIZADO');
});

test('Configurações > Usuários: a outra Gestão rebaixar a última administradora do Perfil (id próprio) → 409 PERFIL_ULTIMA_ADMINISTRADORA; papel inalterado', async () => {
    const r = await erro((usuarios.alterarPapelNaEmpresa as unknown as (...a: unknown[]) => Promise<unknown>)(sessao(ids.outra), { acao: 'papel', usuarioId: ids.alvo, nivel: 'EQUIPE' }, randomUUID(), undefined, ids.empresa));
    assert.equal(r, 'PERFIL_ULTIMA_ADMINISTRADORA:409');
    assert.equal(await papelDe(ids.alvo), 'REPRESENTANTE_AUTORIZADO');
});

test('guarda: com outra administradora do Perfil, o rebaixamento segue', async () => {
    await administrar(ids.outra);
    const r = await erro((usuarios.alterarPapelNaEmpresa as unknown as (...a: unknown[]) => Promise<unknown>)(sessao(ids.outra), { acao: 'papel', usuarioId: ids.alvo, nivel: 'EQUIPE' }, randomUUID(), undefined, ids.empresa));
    assert.equal(r, 'OK');
    assert.equal(await papelDe(ids.alvo), 'ADMINISTRATIVO');
});
