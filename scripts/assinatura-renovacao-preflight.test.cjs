/* eslint-disable @typescript-eslint/no-require-imports */
const test = require('node:test'), assert = require('node:assert/strict');
const { verificar, SCHEMA_SQL } = require('./assinatura-renovacao-preflight.cjs');
const env = { RENDER: 'true', RENDER_SERVICE_ID: 'crn-db493i142hec73ahmoe0', KIDMAIS_DEPLOY_ENV: 'staging',
    ASAAS_AMBIENTE: 'sandbox', ASAAS_API_KEY: '$aact_hmlg_fixture', ASAAS_WEBHOOK_TOKEN: 'x'.repeat(32),
    EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_fixture', EMAIL_REMETENTE: 'teste@example.invalid',
    ADMIN_AUTH_ORIGIN: 'https://kidmais-manager-staging.onrender.com', KIDMAIS_RECONCILIAR_SCHEMA_VALIDADO: '074-075',
    KIDMAIS_RECONCILIAR_DATABASE_URL: 'postgres://fixture:secreto@dpg-daidko3m8hqs73ce4jt0-a:5432/kidmais_staging_1z91',
    KIDMAIS_RECONCILIAR_ALVO: 'kidmais_staging_1z91@dpg-daidko3m8hqs73ce4jt0-a:5432',
    KIDMAIS_RECONCILIAR_TLS: 'render-interno-criptografado' };
function cliente({ db = 'kidmais_staging_1z91', tls = true, guardas = 2, falhar = false } = {}) {
    const queries = [], estado = { fechado: false };
    return { queries, estado, on() {}, async connect() {}, async end() { estado.fechado = true; },
        async query(sql) {
            queries.push(sql);
            if (sql.includes('current_database')) return { rows: [{ db, tls }] };
            if (sql === SCHEMA_SQL) {
                if (falhar) throw Error('segredo do banco');
                return { rows: [{ renovacoes: true, contratacoes: true, fundadores: true, guardas }] };
            }
            return { rows: [] };
        } };
}
test('offline não conecta, não chama provedores e não habilita aplicação', async () => {
    const r = await verificar(env, [], () => { throw Error('conexão proibida'); });
    assert.equal(r.resultado, 'PREPARACAO_CONFERIDA'); assert.equal(r.bancoConsultado, false);
    assert.equal(r.provedoresChamados, false); assert.equal(r.rotinaAplicacaoRemotaHabilitada, false);
    for (const segredo of [env.RESEND_API_KEY, env.ASAAS_API_KEY, 'secreto', env.EMAIL_REMETENTE])
        assert.ok(!JSON.stringify(r).includes(segredo));
});
test('produção, outro recurso, banco, TLS e argumentos de aplicação recusados antes da conexão', async () => {
    for (const alteracao of [{ KIDMAIS_DEPLOY_ENV: 'production' }, { RENDER_SERVICE_ID: 'srv-dak77m2d0e5s73b8rkkg' },
        { ASAAS_AMBIENTE: 'production' }, { RENDER: undefined }, { KIDMAIS_RECONCILIAR_ALVO: 'outro' },
        { KIDMAIS_RECONCILIAR_TLS: 'inseguro' }])
        await assert.rejects(verificar({ ...env, ...alteracao }, ['--consultar-schema'], () => { assert.fail('conectou'); }));
    for (const args of [['--aplicar'], ['--consultar-schema', '--consultar-schema'], ['--empresa=x']])
        await assert.rejects(verificar(env, args), /ARGUMENTO_RECUSADO/);
});
test('schema só lê identidade e catálogos em transação read only, terminada com rollback', async () => {
    const c = cliente();
    const r = await verificar(env, ['--consultar-schema'], () => c);
    assert.equal(r.schemaEstrutural, true); assert.equal(c.queries[0], 'BEGIN READ ONLY');
    assert.equal(c.queries.at(-1), 'ROLLBACK'); assert.equal(c.estado.fechado, true);
    assert.equal(c.queries.length, 6); assert.ok(!SCHEMA_SQL.includes('FROM public.assinatura_renovacoes'));
});
test('banco diferente ou TLS ausente impede consultar schema e sempre encerra conexão', async () => {
    for (const cfg of [{ db: 'kidmais_manager' }, { tls: false }]) {
        const c = cliente(cfg);
        await assert.rejects(verificar(env, ['--consultar-schema'], () => c), /IDENTIDADE_BANCO_RECUSADA/);
        assert.ok(!c.queries.includes(SCHEMA_SQL)); assert.equal(c.estado.fechado, true);
    }
});
test('guardas ausentes e credenciais faltantes são pendências, nunca sucesso de integração', async () => {
    const r = await verificar({ ...env, RESEND_API_KEY: undefined, ASAAS_API_KEY: undefined },
        ['--consultar-schema'], () => cliente({ guardas: 1 }));
    assert.equal(r.resultado, 'PENDENTE');
    assert.deepEqual(r.bloqueios, ['ASAAS_NAO_CONFIGURADO', 'RESEND_NAO_CONFIGURADO', 'SCHEMA_ESTRUTURAL_INCOMPLETO']);
});
test('falha do banco mantém rollback e fechamento', async () => {
    const c = cliente({ falhar: true });
    await assert.rejects(verificar(env, ['--consultar-schema'], () => c));
    assert.equal(c.queries.at(-1), 'ROLLBACK'); assert.equal(c.estado.fechado, true);
});
