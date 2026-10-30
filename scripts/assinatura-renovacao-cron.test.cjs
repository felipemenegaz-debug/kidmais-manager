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
    const { RETRATO_075 } = await import('../lib/assinatura/renovacao-schema-retratos.ts');
    const { executarCron } = require('./assinatura-renovacao-cron.cjs');
    const F = '22222222-2222-4222-8222-222222222222';
    const consultas = [];
    const responder = (sql) => {
        consultas.push(sql);
        if (/current_database/.test(sql)) return [{ db: 'kidmais_staging_1z91', tls: true }];
        if (/instalada075/.test(sql)) return [{ instalada075: true }];
        // B-9 production: capacidade lida antes da primeira empresa (retrato íntegro da 075).
        if (/'colunas'/.test(sql)) return [{ retrato: RETRATO_075 }];
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
    assert.deepEqual([...SERVICOS_TLS_RENOVACAO], [WEB, 'crn-dbg512hsrm7s73chk57g'], 'web de staging e o cron da renovação de staging, nada mais');
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
    // O cron da renovação de staging é aceito pela renovação e recusado pela reconciliação.
    assert.deepEqual(conexaoDaRenovacao(alvo, { ...env, RENDER_SERVICE_ID: 'crn-dbg512hsrm7s73chk57g' }).ssl, { rejectUnauthorized: false, minVersion: 'TLSv1.2' });
    assert.throws(() => opcoesConexao(alvo, { ...env, RENDER_SERVICE_ID: 'crn-dbg512hsrm7s73chk57g' }), /TLS_REDE_PRIVADA_RECUSADA/);
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

// ---- T2 (27/10/2026): credencial igual à DATABASE_URL do web de staging, por exceção explícita, conferida e declarada.
const WEB_T2 = 'srv-daif418ae00c73e8k2gg';
const URL_T2 = 'postgresql://fixture@dpg-daidko3m8hqs73ce4jt0-a:5432/kidmais_staging_1z91';
const t2 = { ...stg, RENDER: 'true', RENDER_SERVICE_ID: WEB_T2, DATABASE_URL: URL_T2, KIDMAIS_RECONCILIAR_DATABASE_URL: URL_T2,
    KIDMAIS_RENOVACAO_CREDENCIAL_DO_SERVICO: 'web-staging-homologacao' };
const semOptIn = { ...t2, KIDMAIS_RENOVACAO_CREDENCIAL_DO_SERVICO: undefined };

test('T2: sem o opt-in, a credencial igual à DATABASE_URL continua recusada (simular e aplicar)', () => {
    assert.throws(() => planejar(semOptIn), /Alvo recusado: use uma conexão própria/);
    assert.throws(() => planejar({ ...semOptIn, KIDMAIS_RENOVACAO_CREDENCIAL_DO_SERVICO: '' }), /Alvo recusado: use uma conexão própria/);
    assert.throws(() => planejar({ ...semOptIn, KIDMAIS_RENOVACAO_MODO: 'aplicar', EMAIL_PROVIDER: 'resend' }, [`--empresas=${E}`]), /Alvo recusado/);
});

test('T2: com o opt-in e todas as condições, aceita e DECLARA a credencial do serviço; aplicar exige --empresas', () => {
    const c = planejar(t2);
    assert.deepEqual([c.modo, c.alvo.credencialDoServico, c.alvo.database], ['simular', true, 'kidmais_staging_1z91']);
    assert.equal(planejar(t2, [`--empresas=${E}`]).alvo.credencialDoServico, true);
    const aplicar = { ...t2, KIDMAIS_RENOVACAO_MODO: 'aplicar', EMAIL_PROVIDER: 'resend' };
    assert.throws(() => planejar(aplicar), /CREDENCIAL_DO_SERVICO_EXIGE_EMPRESAS/);
    assert.equal(planejar(aplicar, [`--empresas=${E}`]).alvo.credencialDoServico, true);
    // URL diferente da DATABASE_URL (ou sem DATABASE_URL): nada de exceção, credencialDoServico false, aplicar global permitido.
    const propria = { ...aplicar, KIDMAIS_RECONCILIAR_DATABASE_URL: 'postgresql://outra@dpg-daidko3m8hqs73ce4jt0-a:5432/kidmais_staging_1z91' };
    assert.equal(planejar(propria).alvo.credencialDoServico, false);
    assert.equal(planejar({ ...aplicar, DATABASE_URL: undefined }).alvo.credencialDoServico, false);
    assert.equal(planejar(stg).alvo.credencialDoServico, false);
});

test('T2: o cron da renovação não usa a credencial do serviço (lista da T2 só com o web)', () => {
    const { CREDENCIAL_DO_SERVICO } = require('./assinatura-renovacao-cron.cjs');
    assert.deepEqual([...CREDENCIAL_DO_SERVICO.servicos], [WEB_T2]);
    assert.throws(() => planejar({ ...t2, RENDER_SERVICE_ID: 'crn-dbg512hsrm7s73chk57g' }), /CREDENCIAL_DO_SERVICO_RECUSADA/);
});

test('T2: opt-in fora das condições é recusado antes de qualquer outra validação do alvo', () => {
    for (const mudanca of [{ KIDMAIS_RENOVACAO_CREDENCIAL_DO_SERVICO: 'sim' }, { KIDMAIS_RENOVACAO_CREDENCIAL_DO_SERVICO: 'WEB-STAGING-HOMOLOGACAO' },
        { KIDMAIS_RENOVACAO_CREDENCIAL_DO_SERVICO: ' web-staging-homologacao' }, { RENDER: undefined }, { RENDER: 'false' },
        { RENDER_SERVICE_ID: 'crn-db493i142hec73ahmoe0' }, { RENDER_SERVICE_ID: 'crn-qualquer' }, { RENDER_SERVICE_ID: undefined },
        { ASAAS_AMBIENTE: 'producao' }, { ASAAS_AMBIENTE: undefined }])
        assert.throws(() => planejar({ ...t2, ...mudanca }), /CREDENCIAL_DO_SERVICO_RECUSADA/, JSON.stringify(mudanca));
    // Production nunca: o opt-in recusa mesmo com o resto de produção correto.
    assert.throws(() => planejar({ ...t2, KIDMAIS_DEPLOY_ENV: 'production' }), /CREDENCIAL_DO_SERVICO_RECUSADA/);
    assert.throws(() => planejar({ ...prod, RENDER_SERVICE_ID: WEB_T2, KIDMAIS_RENOVACAO_CREDENCIAL_DO_SERVICO: 'web-staging-homologacao' }), /CREDENCIAL_DO_SERVICO_RECUSADA/);
    // Opt-in não relaxa nada além da igualdade: alvo errado continua recusado.
    assert.throws(() => planejar({ ...t2, KIDMAIS_RECONCILIAR_ALVO: 'outro@dpg-daidko3m8hqs73ce4jt0-a:5432' }), /Confirme o alvo/);
    const outroBanco = 'postgresql://fixture@localhost:5432/outro';
    assert.throws(() => planejar({ ...t2, DATABASE_URL: outroBanco, KIDMAIS_RECONCILIAR_DATABASE_URL: outroBanco, KIDMAIS_RECONCILIAR_ALVO: 'outro@localhost:5432' }), /ALVO_STAGING_RECUSADO/);
});

test('T2: validarAlvo recusa por padrão para todos os chamadores; só a renovação pede aceitar', () => {
    const { validarAlvo } = require('./assinatura-reconciliar.cjs');
    assert.throws(() => validarAlvo(semOptIn), /Alvo recusado/);
    assert.throws(() => validarAlvo(semOptIn, {}), /Alvo recusado/);
    assert.throws(() => validarAlvo(semOptIn, { credencialDoServico: 'recusar' }), /Alvo recusado/);
    for (const p of ['sim', true, null, 'ACEITAR']) assert.throws(() => validarAlvo(semOptIn, { credencialDoServico: p }), /CREDENCIAL_DO_SERVICO_POLITICA_INVALIDA/);
    assert.equal(validarAlvo(semOptIn, { credencialDoServico: 'aceitar' }).credencialDoServico, true);
    assert.equal(validarAlvo({ ...semOptIn, DATABASE_URL: undefined }).credencialDoServico, false);
    const raiz = path.resolve(__dirname, '..');
    const fontes = fs.readdirSync(path.join(raiz, 'scripts')).filter((a) => /\.cjs$/.test(a) && !/\.test\.cjs$/.test(a))
        .map((a) => [a, fs.readFileSync(path.join(raiz, 'scripts', a), 'utf8')]);
    // Fora da reconciliar (que só repassa a política recebida, com padrão 'recusar'), só a renovação passa política.
    assert.deepEqual(fontes.filter(([a, s]) => a !== 'assinatura-reconciliar.cjs' && /(?<!function )validarAlvo\([^()]*,/.test(s)).map(([a]) => a),
        ['assinatura-renovacao-cron.cjs'], 'só a renovação passa uma política à validarAlvo');
    assert.deepEqual(fontes.filter(([, s]) => /(?<!function )opcoesConexao\([^()]*,[^()]*,[^()]*,/.test(s)).map(([a]) => a),
        ['assinatura-renovacao-cron.cjs'], 'só a renovação passa política de credencial à opcoesConexao');
    const rec = fontes.find(([a]) => a === 'assinatura-reconciliar.cjs')[1];
    assert.deepEqual(rec.match(/(?<!function )validarAlvo\([^()]*,[^)]*\)/g), ['validarAlvo(env, { credencialDoServico })'], 'a reconciliar só repassa a política recebida');
});

test('T2: com a credencial do serviço, aplicar só em fixtures de homologação (com ou sem --agora), antes de qualquer processamento', async () => {
    const { RETRATO_075 } = await import('../lib/assinatura/renovacao-schema-retratos.ts');
    const { executarCron } = require('./assinatura-renovacao-cron.cjs');
    const F = '22222222-2222-4222-8222-222222222222';
    const consultas = [];
    const responder = (sql) => {
        consultas.push(sql);
        if (/current_database/.test(sql)) return [{ db: 'kidmais_staging_1z91', tls: true }];
        if (/instalada075/.test(sql)) return [{ instalada075: true }];
        // B-9 production: capacidade lida antes da primeira empresa (retrato íntegro da 075).
        if (/'colunas'/.test(sql)) return [{ retrato: RETRATO_075 }];
        if (/FROM empresa_assinaturas a\s+JOIN assinatura_contratacoes/.test(sql)) return [{ empresa_id: E }, { empresa_id: F }];
        if (/SELECT id::text AS id, codigo, nome FROM empresas/.test(sql))
            return [{ id: E, codigo: 'cli-real', nome: 'Buffet Real' }, { id: F, codigo: 'hml-renovacao-1', nome: 'TESTE Kidmais — renovação' }];
        if (/pg_try_advisory_lock|pg_locks|pg_advisory_unlock/.test(sql)) throw new Error('não deveria chegar à execução');
        return [];
    };
    const conexao = () => ({ query: async (sql) => ({ rows: responder(sql) }), release() {}, on() {}, connect: async () => undefined, end: async () => undefined });
    class Pool { constructor() { this.query = conexao().query; this.end = async () => undefined; } on() {} async connect() { return conexao(); } }
    class Client { constructor() { Object.assign(this, conexao()); } }
    const alvo = { database: 'kidmais_staging_1z91', local: false, credencialDoServico: true };
    const cfg = { ambiente: 'staging', modo: 'aplicar', rebaixado: false, alvo, empresas: [E, F], agora: null };
    const f = { Pool, Client, conexao: {}, provedor: {}, enviar: async () => { throw new Error('sem envio'); }, origem: 'https://kidmais.example' };
    await assert.rejects(executarCron(cfg, f), /CREDENCIAL_DO_SERVICO_SO_FIXTURES \(1 empresa/);
    await assert.rejects(executarCron({ ...cfg, empresas: [E] }, f), /CREDENCIAL_DO_SERVICO_SO_FIXTURES/);
    await assert.rejects(executarCron({ ...cfg, empresas: null }, f), /CREDENCIAL_DO_SERVICO_EXIGE_EMPRESAS/);
    assert.equal(consultas.some((s) => /pg_try_advisory_lock/.test(s)), false);
    // Só a fixture passa a guarda (e para adiante, aqui); simular com a credencial do serviço não exige fixture.
    await assert.rejects(executarCron({ ...cfg, empresas: [F] }, f), /não deveria chegar à execução/);
    await assert.rejects(executarCron({ ...cfg, modo: 'simular', empresas: [E] }, f), /não deveria chegar à execução/);
    // Sem a credencial do serviço, aplicar sem --agora em empresa real segue a regra anterior (sem a guarda T2).
    await assert.rejects(executarCron({ ...cfg, alvo: { ...alvo, credencialDoServico: false }, empresas: [E] }, f), /não deveria chegar à execução/);
});

test('T2 integrado: planejar → conexaoDaRenovacao com a credencial do serviço E o TLS interno; outras entradas continuam recusando', () => {
    const { opcoesConexao, validarAlvo } = require('./assinatura-reconciliar.cjs');
    const { conexaoDaRenovacao } = require('./assinatura-renovacao-cron.cjs');
    const env = { ...t2, KIDMAIS_RECONCILIAR_TLS: 'render-interno-criptografado' };
    const cfg = planejar(env, ['--empresas=00000000-0000-4000-8000-000000000000']);
    assert.equal(cfg.alvo.credencialDoServico, true);
    assert.deepEqual(conexaoDaRenovacao(cfg.alvo, env).ssl, { rejectUnauthorized: false, minVersion: 'TLSv1.2' });
    // Sem o opt-in, a revalidação do alvo na exceção TLS recusa a igualdade (mesmo com o alvo vindo de um planejamento aceito).
    assert.throws(() => conexaoDaRenovacao(cfg.alvo, { ...env, KIDMAIS_RENOVACAO_CREDENCIAL_DO_SERVICO: undefined }), /Alvo recusado: use uma conexão própria/);
    // Opt-in fora das condições também recusa aqui.
    assert.throws(() => conexaoDaRenovacao(cfg.alvo, { ...env, RENDER_SERVICE_ID: 'crn-qualquer' }), /CREDENCIAL_DO_SERVICO_RECUSADA/);
    // A política padrão de opcoesConexao continua recusando a igualdade para as outras entradas.
    assert.throws(() => opcoesConexao(cfg.alvo, env, ['srv-daif418ae00c73e8k2gg']), /Alvo recusado/);
    assert.throws(() => opcoesConexao(cfg.alvo, { ...env, RENDER_SERVICE_ID: 'crn-db493i142hec73ahmoe0' }), /Alvo recusado/);
    // Sem a igualdade, nada muda: a renovação usa o TLS interno normalmente.
    const propria = { ...env, KIDMAIS_RECONCILIAR_DATABASE_URL: 'postgresql://outra@dpg-daidko3m8hqs73ce4jt0-a:5432/kidmais_staging_1z91' };
    assert.equal(conexaoDaRenovacao(validarAlvo(propria), propria).ssl.minVersion, 'TLSv1.2');
});

test('T2: o relatório do main declara credencialDoServico', () => {
    const fonte = fs.readFileSync(path.join(__dirname, 'assinatura-renovacao-cron.cjs'), 'utf8');
    const main = fonte.slice(fonte.indexOf('async function main()'), fonte.indexOf('if (require.main === module)'));
    assert.match(main, /credencialDoServico: cfg\.alvo\.credencialDoServico/);
});

// ---- Alertas de fixture de homologação desativada (27/10/2026): no relatório, fora do código 2.
test('alertas de fixture desativada: informativos, fora do código 2; real, fixture ativa e sem cadastro continuam contando', () => {
    const { separarAlertasInformativos } = require('./assinatura-renovacao-cron.cjs');
    const ehFixture = ({ codigo, nome }) => typeof codigo === 'string' && typeof nome === 'string' && codigo.startsWith('hml-') && nome.startsWith('TESTE ');
    const FX = 'aaaaaaaa-0000-4000-8000-000000000001', REAL = 'bbbbbbbb-0000-4000-8000-000000000002', FXA = 'cccccccc-0000-4000-8000-000000000003',
        RD = 'dddddddd-0000-4000-8000-000000000004', SO_COD = 'eeeeeeee-0000-4000-8000-000000000005', SEM = 'ffffffff-0000-4000-8000-000000000006';
    const linhas = [
        { id: FX, codigo: 'hml-pr-essencial', nome: 'TESTE Kidmais — r3 F1', status: 'DESATIVADA' },
        { id: REAL, codigo: 'buffet-real', nome: 'Buffet Real', status: 'ATIVA' },
        { id: FXA, codigo: 'hml-ativa', nome: 'TESTE ativa', status: 'ATIVA' },
        { id: RD, codigo: 'buffet-desativado', nome: 'Buffet Desativado', status: 'DESATIVADA' },
        { id: SO_COD, codigo: 'hml-sem-nome', nome: 'Buffet sem prefixo', status: 'DESATIVADA' },
    ];
    const alerta = (empresaId) => ({ empresaId, resultado: 'REVISAO_EXISTENTE', motivo: 'REVISAO_EXISTENTE' });
    const rel = (alertas, extra = {}) => ({ execucao: 'CONCLUIDA', codigo: alertas.length ? 2 : 0, alertas, processadas: alertas.length, ...extra });
    // Só fixture desativada: 2 → 0, continua no relatório.
    let r = separarAlertasInformativos(rel([alerta(FX)]), linhas, ehFixture);
    assert.deepEqual([r.codigo, r.alertas.length, r.alertasInformativos.map((a) => a.empresaId)], [0, 0, [FX]]);
    // Misturado com real: continua 2; a real fica em alertas, a fixture em informativos.
    r = separarAlertasInformativos(rel([alerta(FX), alerta(REAL)]), linhas, ehFixture);
    assert.deepEqual([r.codigo, r.alertas.map((a) => a.empresaId), r.alertasInformativos.map((a) => a.empresaId)], [2, [REAL], [FX]]);
    // Contam: fixture ativa, real desativada, só o código de fixture, empresa sem cadastro lido.
    for (const id of [FXA, RD, SO_COD, SEM]) {
        r = separarAlertasInformativos(rel([alerta(id)]), linhas, ehFixture);
        assert.deepEqual([r.codigo, r.alertas.length, r.alertasInformativos.length], [2, 1, 0], id);
    }
    // Interrupção (1) e execução não concluída (2) não mudam, mesmo só com fixture desativada.
    r = separarAlertasInformativos(rel([alerta(FX)], { execucao: 'INTERROMPIDA', codigo: 1 }), linhas, ehFixture);
    assert.equal(r.codigo, 1);
    r = separarAlertasInformativos(rel([alerta(FX)], { execucao: 'TRAVA_PERDIDA', codigo: 2 }), linhas, ehFixture);
    assert.deepEqual([r.codigo, r.alertasInformativos.length], [2, 1]);
    // Defensivo: só o 2 é rebaixado (um 1 nunca vira 0, mesmo num relatório CONCLUIDA).
    r = separarAlertasInformativos(rel([alerta(FX)], { codigo: 1 }), linhas, ehFixture);
    assert.equal(r.codigo, 1);
    // Nunca sobe o código.
    r = separarAlertasInformativos(rel([alerta(REAL)], { codigo: 0 }), linhas, ehFixture);
    assert.equal(r.codigo, 0);
});

test('alertas de fixture desativada: executarCron lê o cadastro e usa a regra única ehFixtureHomologacao', () => {
    const fonte = fs.readFileSync(path.join(__dirname, 'assinatura-renovacao-cron.cjs'), 'utf8');
    const exec = fonte.slice(fonte.indexOf('async function executarCron('), fonte.indexOf('async function main()'));
    assert.match(exec, /SELECT id::text AS id, codigo, nome, status::text AS status FROM empresas WHERE id = ANY\(\$1::uuid\[\]\)/);
    assert.match(exec, /return separarAlertasInformativos\(relatorio, linhas, ehFixtureHomologacao\);/);
    assert.match(exec, /alertasInformativos: \[\]/);
});

test('D-P5-5 = B: a contagem envolve o provedor JÁ bloqueado pela simulação (por fora) e os instrumentos são por empresa', () => {
    const fonte = require('node:fs').readFileSync(require('node:path').join(__dirname, 'assinatura-renovacao-cron.cjs'), 'utf8');
    assert.match(fonte, /const provedor = provedorDaExecucao\(f\.provedor, aplicar, \{\}\);/);
    assert.match(fonte, /processar: \(e, travar, i\) => processarRenovacao\(e, \{ \.\.\.deps, travar, provedor: instrumentarProvedor\(provedor, i\),\s*repositorio: observarRepositorio\(repositorio, i\) \}\)/);
});
