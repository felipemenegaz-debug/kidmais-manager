/* eslint-disable @typescript-eslint/no-require-imports */
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { planejar } = require('./assinatura-renovacao-cron.cjs');

/** B-9: o cron da renovação decide tudo antes de conectar; nenhuma destas chamadas abre socket. */
const E = '11111111-1111-4111-8111-111111111111';
const stg = { KIDMAIS_DEPLOY_ENV: 'staging', KIDMAIS_RENOVACAO_MODO: 'simular', ASAAS_AMBIENTE: 'sandbox',
    KIDMAIS_RECONCILIAR_DATABASE_URL: 'postgresql://fixture@dpg-daidko3m8hqs73ce4jt0-a:5432/kidmais_staging_1z91',
    KIDMAIS_RECONCILIAR_ALVO: 'kidmais_staging_1z91@dpg-daidko3m8hqs73ce4jt0-a:5432' };
const prod = { KIDMAIS_DEPLOY_ENV: 'production', RENDER: 'true', KIDMAIS_RENOVACAO_MODO: 'simular', ASAAS_AMBIENTE: 'producao', DATABASE_SSL: 'true',
    KIDMAIS_RECONCILIAR_DATABASE_URL: 'postgresql://fixture@dpg-dak750gae00c73fudmg0-a:5432/kidmais_production',
    KIDMAIS_RECONCILIAR_ALVO: 'kidmais_production@dpg-dak750gae00c73fudmg0-a:5432' };
const hoje = new Date('2027-09-06T15:00:00Z');

test('aguardando sai sem conectar (nem alvo é exigido); ambiente e modo inválidos são recusados', () => {
    assert.equal(planejar({ KIDMAIS_DEPLOY_ENV: 'staging', KIDMAIS_RENOVACAO_MODO: 'aguardando' }), null);
    assert.equal(planejar({ KIDMAIS_DEPLOY_ENV: 'production', KIDMAIS_RENOVACAO_MODO: 'aguardando' }), null);
    assert.throws(() => planejar({ KIDMAIS_DEPLOY_ENV: 'staging', KIDMAIS_RENOVACAO_MODO: 'aguardando' }, [`--empresas=${E}`]), /ARGUMENTOS_EM_AGUARDANDO/);
    for (const amb of [undefined, '', 'dev', 'PRODUCTION']) assert.throws(() => planejar({ ...stg, KIDMAIS_DEPLOY_ENV: amb }), /AMBIENTE_RECUSADO/);
    for (const modo of [undefined, '', 'conferir', '--aplicar']) assert.throws(() => planejar({ ...stg, KIDMAIS_RENOVACAO_MODO: modo }), /MODO_INVALIDO/);
});

test('staging: alvo e sandbox exatos; aplicar exige Resend', () => {
    assert.deepEqual(Object.entries(planejar(stg)).filter(([k]) => ['ambiente', 'modo', 'rebaixado', 'empresas', 'agora'].includes(k)),
        [['ambiente', 'staging'], ['modo', 'simular'], ['rebaixado', false], ['empresas', null], ['agora', null]]);
    assert.throws(() => planejar({ ...stg, ASAAS_AMBIENTE: 'producao' }), /PROVEDOR_RECUSADO/);
    assert.throws(() => planejar({ ...stg, KIDMAIS_RECONCILIAR_DATABASE_URL: 'postgresql://fixture@localhost:5432/outro', KIDMAIS_RECONCILIAR_ALVO: 'outro@localhost:5432' }), /ALVO_STAGING_RECUSADO/);
    assert.throws(() => planejar({ ...stg, KIDMAIS_RENOVACAO_MODO: 'aplicar' }), /EMAIL_RECUSADO/);
    assert.throws(() => planejar({ ...stg, KIDMAIS_RENOVACAO_MODO: 'aplicar', EMAIL_PROVIDER: 'arquivo' }), /EMAIL_RECUSADO/);
    assert.equal(planejar({ ...stg, KIDMAIS_RENOVACAO_MODO: 'aplicar', EMAIL_PROVIDER: 'resend' }).modo, 'aplicar');
});

test('production: aplicar só a partir de KIDMAIS_RENOVACAO_PRODUCAO_DESDE; antes, ausente ou inválida, rebaixa para simular', () => {
    const aplicar = { ...prod, KIDMAIS_RENOVACAO_MODO: 'aplicar', EMAIL_PROVIDER: 'resend' };
    for (const desde of [undefined, '', '2027-09-07', '2027-02-30', '07/09/2027']) {
        const c = planejar({ ...aplicar, KIDMAIS_RENOVACAO_PRODUCAO_DESDE: desde }, [], hoje);
        assert.deepEqual([c.modo, c.rebaixado], ['simular', true], String(desde));
    }
    for (const desde of ['2027-09-06', '2027-01-01']) assert.deepEqual([planejar({ ...aplicar, KIDMAIS_RENOVACAO_PRODUCAO_DESDE: desde }, [], hoje).modo], ['aplicar'], desde);
    // 23h30 de 05/09 em Brasília = 02h30Z de 06/09: ainda antes da data autorizada.
    assert.equal(planejar({ ...aplicar, KIDMAIS_RENOVACAO_PRODUCAO_DESDE: '2027-09-06' }, [], new Date('2027-09-06T02:30:00Z')).modo, 'simular');
    assert.throws(() => planejar({ ...prod, KIDMAIS_RENOVACAO_MODO: 'aplicar', KIDMAIS_RENOVACAO_PRODUCAO_DESDE: '2027-01-01' }, [], hoje), /EMAIL_RECUSADO/);
    assert.throws(() => planejar({ ...prod, ASAAS_AMBIENTE: 'sandbox' }), /recusado/);
    assert.throws(() => planejar({ ...prod, KIDMAIS_RECONCILIAR_DATABASE_URL: stg.KIDMAIS_RECONCILIAR_DATABASE_URL, KIDMAIS_RECONCILIAR_ALVO: stg.KIDMAIS_RECONCILIAR_ALVO }), /ALVO_PRODUCAO_RECUSADO/);
});

test('argumentos de homologação: só em staging, --agora exige --empresas, lista e instante validados', () => {
    assert.throws(() => planejar(prod, [`--empresas=${E}`]), /ARGUMENTOS_SO_EM_STAGING/);
    assert.throws(() => planejar(prod, ['--agora=2027-09-06T12:00:00Z']), /ARGUMENTOS_SO_EM_STAGING/);
    assert.throws(() => planejar(stg, ['--agora=2027-09-06T12:00:00Z']), /AGORA_EXIGE_EMPRESAS/);
    for (const agora of ['2027-09-06', '2027-02-30T12:00:00Z', 'ontem']) assert.throws(() => planejar(stg, [`--empresas=${E}`, `--agora=${agora}`]), /AGORA_INVALIDO/);
    assert.throws(() => planejar(stg, ['--empresas=nao-uuid']));
    assert.throws(() => planejar(stg, [`--empresas=${E}`, `--empresas=${E}`]), /repetido/);
    assert.throws(() => planejar(stg, ['--aplicar']), /desconhecido/);
    const c = planejar(stg, [`--empresas=${E}`, '--agora=2027-09-06T12:00:00Z']);
    assert.deepEqual([c.empresas, c.agora.toISOString()], [[E], '2027-09-06T12:00:00.000Z']);
});

test('entrada nova não é chamada pelo cron da reconciliação nem por scripts do package.json', () => {
    const raiz = path.resolve(__dirname, '..');
    assert.doesNotMatch(fs.readFileSync(path.join(raiz, 'scripts/assinatura-cron.cjs'), 'utf8'), /renovacao/);
    assert.doesNotMatch(fs.readFileSync(path.join(raiz, 'package.json'), 'utf8'), /assinatura-renovacao-cron/);
});

test('homologação com alvo remoto: --agora com aplicar só para fixtures (guarda da ferramenta restrita reutilizada), antes de qualquer processamento', async () => {
    const { executarCron } = require('./assinatura-renovacao-cron.cjs');
    const F = '22222222-2222-4222-8222-222222222222';
    const consultas = [];
    const responder = (sql) => {
        consultas.push(sql);
        if (/current_database/.test(sql)) return [{ db: 'kidmais_staging_1z91', tls: true }];
        if (/instalada075/.test(sql)) return [{ instalada075: true }];
        if (/FROM empresa_assinaturas a\s+JOIN assinatura_contratacoes/.test(sql)) return [{ empresa_id: E }, { empresa_id: F }];
        if (/SELECT id::text AS id, codigo, nome FROM empresas/.test(sql))
            return [{ id: E, codigo: 'cli-real', nome: 'Buffet Real' }, { id: F, codigo: 'hml-renovacao-1', nome: 'TESTE Kidmais — renovação' }];
        if (/pg_try_advisory_lock|pg_locks|pg_advisory_unlock/.test(sql)) throw new Error('não deveria chegar à execução');
        return [];
    };
    const conexao = () => ({ query: async (sql) => ({ rows: responder(sql) }), release() {}, on() {}, connect: async () => undefined, end: async () => undefined });
    class Pool { constructor() { this.query = conexao().query; this.end = async () => undefined; } on() {} async connect() { return conexao(); } }
    class Client { constructor() { Object.assign(this, conexao()); } }
    const cfg = { ambiente: 'staging', modo: 'aplicar', rebaixado: false, alvo: { database: 'kidmais_staging_1z91', local: false }, empresas: [E, F], agora: new Date('2027-09-06T12:00:00Z') };
    const f = { Pool, Client, conexao: {}, provedor: {}, enviar: async () => { throw new Error('sem envio'); }, origem: 'https://kidmais.example' };
    await assert.rejects(executarCron(cfg, f), /fixtures de homologação \(1 empresa/);
    assert.equal(consultas.some((s) => /pg_try_advisory_lock/.test(s)), false);
    // Simulação (READ ONLY) não precisa da guarda; só a empresa fixture com aplicar também passa a guarda (para antes na execução, aqui).
    await assert.rejects(executarCron({ ...cfg, empresas: [F] }, f), /não deveria chegar à execução/);
});

// ---- T1 (26/10/2026): lista fechada da exceção TLS render-interno-criptografado para a renovação.
test('T1: TLS interno da renovação só para a lista fechada (web de staging); reconciliação inalterada', () => {
    const { validarAlvo, opcoesConexao, SERVICOS_TLS_RECONCILIACAO } = require('./assinatura-reconciliar.cjs');
    const { conexaoDaRenovacao, SERVICOS_TLS_RENOVACAO } = require('./assinatura-renovacao-cron.cjs');
    const WEB = 'srv-daif418ae00c73e8k2gg', CRON_RECONCILIACAO = 'crn-db493i142hec73ahmoe0';
    const env = { RENDER: 'true', RENDER_SERVICE_ID: WEB, KIDMAIS_DEPLOY_ENV: 'staging', ASAAS_AMBIENTE: 'sandbox', KIDMAIS_RECONCILIAR_TLS: 'render-interno-criptografado',
        KIDMAIS_RECONCILIAR_DATABASE_URL: 'postgresql://fixture@dpg-daidko3m8hqs73ce4jt0-a:5432/kidmais_staging_1z91?sslmode=require',
        KIDMAIS_RECONCILIAR_ALVO: 'kidmais_staging_1z91@dpg-daidko3m8hqs73ce4jt0-a:5432' };
    const alvo = validarAlvo(env);
    // Listas fechadas e disjuntas.
    assert.deepEqual([...SERVICOS_TLS_RENOVACAO], [WEB], 'cron da renovação só entra depois de criado (CRON_RENOVACAO_STAGING = null)');
    assert.deepEqual([...SERVICOS_TLS_RECONCILIACAO], [CRON_RECONCILIACAO]);
    assert.ok(Object.isFrozen(SERVICOS_TLS_RENOVACAO) && Object.isFrozen(SERVICOS_TLS_RECONCILIACAO));
    // Renovação: web aceito, com a mesma política (sem verificação de certificado, TLS 1.2+).
    assert.deepEqual(conexaoDaRenovacao(alvo, env).ssl, { rejectUnauthorized: false, minVersion: 'TLSv1.2' });
    // Sem o opt-in, verificação de certificado ativa.
    assert.equal(conexaoDaRenovacao(alvo, { ...env, KIDMAIS_RECONCILIAR_TLS: undefined }).ssl.rejectUnauthorized, true);
    // Renovação recusa o cron da reconciliação e qualquer outro serviço; mesmas guardas de ambiente e alvo.
    for (const mudanca of [{ RENDER_SERVICE_ID: CRON_RECONCILIACAO }, { RENDER_SERVICE_ID: 'crn-qualquer' }, { RENDER_SERVICE_ID: undefined }, { RENDER: undefined },
        { KIDMAIS_DEPLOY_ENV: 'production' }, { ASAAS_AMBIENTE: 'producao' }])
        assert.throws(() => conexaoDaRenovacao(alvo, { ...env, ...mudanca }), /TLS_REDE_PRIVADA_RECUSADA/, JSON.stringify(mudanca));
    for (const [host, db, porta] of [['example.test', 'kidmais_staging_1z91', 5432], ['dpg-daidko3m8hqs73ce4jt0-a', 'outro', 5432], ['dpg-daidko3m8hqs73ce4jt0-a', 'kidmais_staging_1z91', 6432]]) {
        const alterado = { ...env, KIDMAIS_RECONCILIAR_DATABASE_URL: `postgresql://fixture@${host}:${porta}/${db}`, KIDMAIS_RECONCILIAR_ALVO: `${db}@${host}:${porta}` };
        assert.throws(() => conexaoDaRenovacao(validarAlvo(alterado), alterado), /TLS_REDE_PRIVADA_RECUSADA/);
    }
    assert.throws(() => conexaoDaRenovacao({ ...alvo, connectionString: 'postgresql://fixture@example.test/outro' }, env), /TLS_REDE_PRIVADA_RECUSADA/);
    assert.throws(() => conexaoDaRenovacao(alvo, { ...env, KIDMAIS_RECONCILIAR_TLS: 'no-verify' }), /TLS_POLITICA_RECUSADA/);
    // Reconciliação: inalterada — o web continua recusado; o cron dela continua aceito.
    assert.throws(() => opcoesConexao(alvo, env), /TLS_REDE_PRIVADA_RECUSADA/);
    assert.deepEqual(opcoesConexao(alvo, { ...env, RENDER_SERVICE_ID: CRON_RECONCILIACAO }).ssl, { rejectUnauthorized: false, minVersion: 'TLSv1.2' });
});

test('T1: o main da renovação calcula a conexão pela lista da renovação, antes de conectar', () => {
    const fonte = fs.readFileSync(path.join(__dirname, 'assinatura-renovacao-cron.cjs'), 'utf8');
    const main = fonte.slice(fonte.indexOf('async function main()'), fonte.indexOf('if (require.main === module)'));
    assert.match(main, /conexao: conexaoDaRenovacao\(cfg\.alvo, process\.env\)/);
    assert.doesNotMatch(main, /opcoesConexao\(/, 'o main não chama a política da reconciliação diretamente');
});
