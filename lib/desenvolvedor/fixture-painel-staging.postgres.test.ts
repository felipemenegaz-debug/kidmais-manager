import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client } from 'pg';
import type { DbExecutor } from '../db/contracts.ts';
import { lerEstadoComercial } from '../assinatura/estado.ts';
import { conferirSenha, criarHashSenha, senhaValida } from '../autenticacao/senha.ts';
import { perfilDoTenantOuNulo } from '../perfil/tenant.ts';
import { revogarConcessoesAtivasDoUsuario } from '../perfil/protecao-usuarios.ts';
import { conectarDescartavel, encerrarDescartavel } from '../comercial/postgres-descartavel.ts';

/**
 * O script REAL de fixtures do painel (scripts/fixture-painel-staging.cjs) no PostgreSQL DESCARTÁVEL com o schema vigente
 * (modelo "079") e os serviços de domínio reais: gatilhos de empresa e de membership (043/045/063), constraints de
 * isenção, criação única, preservação das outras linhas, limpeza e conferência.
 *
 * Substituição de teste (única, como em fixture-atualizacao-staging.postgres.test.ts): o cliente recebe a trava do staging,
 * mas conversa com o banco descartável, e a consulta de identidade responde a identidade do staging. A identidade real é
 * conferida pelo próprio script no servidor. As senhas são sintéticas, só deste teste.
 */
const exigir = createRequire(import.meta.url);
type Res = Record<string, unknown> & { resultado: string };
const s = exigir('../../scripts/fixture-painel-staging.cjs') as {
    EMPRESAS: Array<{ chave: string; id: string; codigo: string }>; CONTAS: Array<{ chave: string; id: string; email: string }>; ARQUIVO: string;
    criar: (a: Record<string, unknown>) => Promise<Res>; encerrar: (a: Record<string, unknown>) => Promise<Res>;
    conferirEncerramento: (a: Record<string, unknown>) => Promise<Res>; diagnosticar: (a: Record<string, unknown>) => Promise<Res>;
};
const { SQL_IDENTIDADE } = exigir('../../scripts/conexao-staging.cjs') as { SQL_IDENTIDADE: string };
const ENV = {
    RENDER: 'true', RENDER_SERVICE_ID: 'srv-daif418ae00c73e8k2gg', KIDMAIS_DEPLOY_ENV: 'staging', ASAAS_AMBIENTE: 'sandbox', DATABASE_SSL: 'false',
    DATABASE_URL: 'postgresql://sintetico:sintetico@dpg-daidko3m8hqs73ce4jt0-a:5432/kidmais_staging_1z91',
};
const SENHAS = ['senha-sintetica-teste-A1', 'senha-sintetica-teste-B2'];
const servicos = { criarHashSenha, senhaValida, perfilDoTenantOuNulo, revogarConcessoesAtivasDoUsuario };
const sem = () => {};
const IDS = s.EMPRESAS.map((e) => e.id);
const CONTAS = s.CONTAS.map((c) => c.id);

let client: Client;
let tx: DbExecutor;
let dir: string;
let outra: string;
const impressaoOutra = async () => JSON.stringify((await client.query("SELECT id, status FROM empresas WHERE id = $1", [outra])).rows);

function ClienteStaging(this: unknown) { /* alvo de staging recebido, conversa com o descartável */ }
ClienteStaging.prototype.connect = async () => {};
ClienteStaging.prototype.end = async () => {};
ClienteStaging.prototype.query = async (t: string, v?: unknown[]) => t === SQL_IDENTIDADE
    ? { rows: [{ db: 'kidmais_staging_1z91', tls: false, servidor_privado: true }], rowCount: 1 }
    : client.query(t, v);

test.before(async () => {
    client = await conectarDescartavel();
    tx = { query: async (t: string, v?: unknown[]) => { const r = await client.query(t, v as unknown[]); return { rows: r.rows, rowCount: r.rowCount ?? 0 }; } } as unknown as DbExecutor;
    dir = mkdtempSync(join(tmpdir(), 'fixture-painel-pg-'));
    outra = (await client.query<{ id: string }>("INSERT INTO empresas (codigo, nome, status) VALUES ('fx-painel-outra', 'Outra empresa (teste)', 'PROVISIONAMENTO') RETURNING id")).rows[0].id;
    await client.query("UPDATE empresas SET status='ATIVA' WHERE id=$1", [outra]);
});
test.after(async () => { if (client) await encerrarDescartavel(client); });

test('diagnóstico (só leitura): fixtures desta rodada livres; nada é gravado', async () => {
    const antes = (await client.query('SELECT count(*)::int AS n FROM empresas')).rows[0].n;
    const r = await s.diagnosticar({ env: ENV, Client: ClienteStaging });
    assert.equal(r.resultado, 'DIAGNOSTICO');
    assert.equal(r.fixturesDestaRodadaLivres, true);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM empresas')).rows[0].n, antes);
});

test('criação: 3 empresas ATIVAS e isentas (acesso COMPLETO), 2 contas com o hash da senha digitada, 4 vínculos de Gestão; outra empresa intacta', async () => {
    const antes = await impressaoOutra();
    const fila = [SENHAS[0], SENHAS[0], SENHAS[1], SENHAS[1]];
    const r = await s.criar({ env: ENV, Client: ClienteStaging, servicos, lerSenha: async () => fila.shift() ?? '', dir, disco: sem });
    assert.equal(r.resultado, 'PASS', JSON.stringify(r.falha));
    const empresas = (await client.query<{ codigo: string; status: string }>('SELECT codigo, status FROM empresas WHERE id = ANY($1::uuid[]) ORDER BY codigo', [IDS])).rows;
    assert.deepEqual(empresas.map((e) => e.status), ['ATIVA', 'ATIVA', 'ATIVA']);
    for (const id of IDS) assert.equal((await lerEstadoComercial(tx, id)).acesso.nivel, 'COMPLETO');
    const vinculos = (await client.query('SELECT count(*)::int AS n FROM memberships WHERE empresa_id = ANY($1::uuid[]) AND status=\'ATIVA\' AND papel=\'REPRESENTANTE_AUTORIZADO\'', [IDS])).rows[0].n;
    assert.equal(vinculos, 4);
    const contas = (await client.query<{ id: string; senha_hash: string; ativo: boolean; papel: string }>('SELECT id, senha_hash, ativo, papel FROM usuarios_administrativos WHERE id = ANY($1::uuid[]) ORDER BY email', [CONTAS])).rows;
    assert.equal(contas.length, 2);
    for (const [i, c] of contas.entries()) {
        assert.ok(c.ativo); assert.equal(c.papel, 'ADMINISTRATIVO');
        assert.ok(await conferirSenha(SENHAS[i], c.senha_hash), 'a senha digitada abre a conta');
    }
    assert.equal(await impressaoOutra(), antes, 'outra empresa intacta');
    assert.ok(!readFileSync(join(dir, s.ARQUIVO), 'utf8').includes(SENHAS[0]), 'estado sem senha');
    // repetição recusada
    await assert.rejects(s.criar({ env: ENV, Client: ClienteStaging, servicos, lerSenha: async () => '', dir, disco: sem }), /RODADA_EXISTENTE/);
    const r2 = await s.diagnosticar({ env: ENV, Client: ClienteStaging });
    assert.equal(r2.fixturesDestaRodadaLivres, false, 'o diagnóstico vê as fixtures criadas');
});

test('limpeza depois de uma homologação simulada (Perfil com id próprio, concessões e sessões): tudo inativo e VERIFICADO; nada apagado', async () => {
    const [A, B] = CONTAS;
    const P = s.EMPRESAS.find((e) => e.chave === 'P')!;
    // Homologação simulada: Perfil da empresa P (id próprio, associado pelo código) com concessões para A e B, e sessões abertas.
    const perfil = (await client.query<{ id: string }>('INSERT INTO perfil_empresas (codigo, nome_comercial) VALUES ($1, $2) RETURNING id', [P.codigo, 'Perfil P (teste)'])).rows[0].id;
    assert.notEqual(perfil, P.id);
    for (const u of [A, B])
        await client.query("INSERT INTO perfil_empresa_concessoes (empresa_id, usuario_id, capacidade, concedido_por, motivo, referencia_autorizacao) VALUES ($1, $2, 'PERFIL_ADMINISTRAR_CONCESSOES', $3, 'teste', 'TESTE')", [perfil, u, A]);
    for (const u of [A, B])
        await client.query("INSERT INTO sessoes_administrativas (usuario_id, token_hash, csrf_hash, autenticado_em, ultima_atividade_em, expira_em) VALUES ($1, md5(random()::text) || md5(random()::text), md5(random()::text) || md5(random()::text), now(), now(), now() + interval '1 hour')", [u]);
    const linhas = async () => (await client.query('SELECT (SELECT count(*) FROM empresas WHERE id = ANY($1::uuid[])) + (SELECT count(*) FROM memberships WHERE empresa_id = ANY($1::uuid[])) + (SELECT count(*) FROM usuarios_administrativos WHERE id = ANY($2::uuid[])) AS n', [IDS, CONTAS])).rows[0].n;
    const antes = await linhas();
    const outraAntes = await impressaoOutra();

    const r = await s.encerrar({ env: ENV, Client: ClienteStaging, servicos, dir, disco: sem });
    assert.equal(r.resultado, 'ENCERRADO');
    assert.equal(r.concessoesRevogadas, 2);
    assert.equal(r.sessoesRevogadas, 2);
    const c = await s.conferirEncerramento({ env: ENV, Client: ClienteStaging, dir, disco: sem });
    assert.equal(c.resultado, 'VERIFICADO', JSON.stringify(c));
    assert.equal(await linhas(), antes, 'nada apagado');
    assert.equal(await impressaoOutra(), outraAntes, 'outra empresa intacta');
    const revogadas = (await client.query<{ revogado_por: string }>('SELECT revogado_por FROM perfil_empresa_concessoes WHERE empresa_id = $1', [perfil])).rows;
    assert.ok(revogadas.every((x) => x.revogado_por === A));
    // a limpeza é repetível sem efeito novo
    assert.equal((await s.encerrar({ env: ENV, Client: ClienteStaging, servicos, dir, disco: sem })).resultado, 'ENCERRADO');
    assert.equal((await s.conferirEncerramento({ env: ENV, Client: ClienteStaging, dir, disco: sem })).resultado, 'VERIFICADO');
});
