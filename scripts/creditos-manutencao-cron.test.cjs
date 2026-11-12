/* eslint-disable @typescript-eslint/no-require-imports */
// Cron diário da manutenção de créditos (staging): modos, alvo e a lista fechada da exceção TLS. Sem banco e sem rede.
const test = require('node:test'), assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { planejar } = require('./creditos-manutencao-cron.cjs');
const { SERVICOS_TLS_MANUTENCAO, CRON_MANUTENCAO_STAGING, conexaoDaManutencao, falhaSegura } = require('./creditos-manutencao.cjs');
const { validarAlvo, opcoesConexao, SERVICOS_TLS_RECONCILIACAO } = require('./assinatura-reconciliar.cjs');

const URL_STAGING = 'postgresql://fixture@dpg-daidko3m8hqs73ce4jt0-a:5432/kidmais_staging_1z91';
const ALVO_STAGING = 'kidmais_staging_1z91@dpg-daidko3m8hqs73ce4jt0-a:5432';
const CRON_RECONCILIACAO = 'crn-db493i142hec73ahmoe0';
const env = { KIDMAIS_DEPLOY_ENV: 'staging', KIDMAIS_MANUTENCAO_MODO: 'simular', ASAAS_AMBIENTE: 'sandbox',
    KIDMAIS_RECONCILIAR_DATABASE_URL: URL_STAGING, KIDMAIS_RECONCILIAR_ALVO: ALVO_STAGING };

test('aguardando: nada lido nem conectado, mesmo sem alvo; simular e aplicar só com alvo de staging e sandbox', () => {
    assert.equal(planejar({ KIDMAIS_DEPLOY_ENV: 'staging', KIDMAIS_MANUTENCAO_MODO: 'aguardando' }), null);
    assert.deepEqual(planejar(env), []);
    assert.deepEqual(planejar({ ...env, KIDMAIS_MANUTENCAO_MODO: 'aplicar' }), ['--aplicar']);
    for (const [alteracao, motivo] of [
        [{ KIDMAIS_DEPLOY_ENV: 'production' }, /AMBIENTE_RECUSADO/],
        [{ KIDMAIS_DEPLOY_ENV: undefined }, /AMBIENTE_RECUSADO/],
        [{ KIDMAIS_MANUTENCAO_MODO: undefined }, /MODO_INVALIDO/],
        [{ KIDMAIS_MANUTENCAO_MODO: 'APLICAR' }, /MODO_INVALIDO/],
        [{ KIDMAIS_MANUTENCAO_MODO: 'enviar-emails' }, /MODO_INVALIDO/],
        [{ ASAAS_AMBIENTE: 'producao' }, /PROVEDOR_RECUSADO/],
        [{ KIDMAIS_RECONCILIAR_DATABASE_URL: undefined }, /KIDMAIS_RECONCILIAR_DATABASE_URL/],
        [{ KIDMAIS_RECONCILIAR_ALVO: 'outro@dpg-daidko3m8hqs73ce4jt0-a:5432' }, /Confirme o alvo/],
        [{ KIDMAIS_RECONCILIAR_DATABASE_URL: 'postgresql://fixture@outro-host:5432/kidmais_staging_1z91', KIDMAIS_RECONCILIAR_ALVO: 'kidmais_staging_1z91@outro-host:5432' }, /ALVO_STAGING_RECUSADO/],
        [{ KIDMAIS_RECONCILIAR_DATABASE_URL: 'postgresql://fixture@dpg-daidko3m8hqs73ce4jt0-a:5432/kidmais_manager', KIDMAIS_RECONCILIAR_ALVO: 'kidmais_manager@dpg-daidko3m8hqs73ce4jt0-a:5432' }, /recusado/],
    ]) assert.throws(() => planejar({ ...env, ...alteracao }), motivo, JSON.stringify(alteracao));
});

test('produção nunca planeja por este cron, em nenhum modo', () => {
    for (const modo of ['aguardando', 'simular', 'aplicar'])
        assert.throws(() => planejar({ ...env, KIDMAIS_DEPLOY_ENV: 'production', KIDMAIS_MANUTENCAO_MODO: modo }), /AMBIENTE_RECUSADO/);
});

test('lista TLS da manutenção: reconciliação + cron da manutenção, fechada; a da reconciliação não muda', () => {
    assert.equal(CRON_MANUTENCAO_STAGING, 'crn-dblpgn3m8hqs739r366g');
    assert.deepEqual([...SERVICOS_TLS_MANUTENCAO], [CRON_RECONCILIACAO, CRON_MANUTENCAO_STAGING]);
    assert.deepEqual([...SERVICOS_TLS_RECONCILIACAO], [CRON_RECONCILIACAO]);
    assert.ok(Object.isFrozen(SERVICOS_TLS_MANUTENCAO));
    assert.ok(!SERVICOS_TLS_MANUTENCAO.includes('srv-daif418ae00c73e8k2gg'), 'o web não entra');
});

test('exceção TLS: o cron da manutenção conecta com a lista dela e é recusado pela da reconciliação; outro serviço, recusado', () => {
    const base = { ...env, RENDER: 'true', KIDMAIS_RECONCILIAR_TLS: 'render-interno-criptografado' };
    const alvo = validarAlvo(base);
    const doCron = { ...base, RENDER_SERVICE_ID: CRON_MANUTENCAO_STAGING };
    const op = opcoesConexao(alvo, doCron, SERVICOS_TLS_MANUTENCAO);
    assert.deepEqual(op.ssl, { rejectUnauthorized: false, minVersion: 'TLSv1.2' });
    assert.throws(() => opcoesConexao(alvo, doCron), /TLS_REDE_PRIVADA_RECUSADA/, 'padrão da reconciliação não inclui o cron novo');
    assert.ok(opcoesConexao(alvo, { ...base, RENDER_SERVICE_ID: CRON_RECONCILIACAO }, SERVICOS_TLS_MANUTENCAO).ssl);
    for (const alteracao of [{ RENDER_SERVICE_ID: 'srv-daif418ae00c73e8k2gg' }, { RENDER_SERVICE_ID: 'crn-outro' }, { RENDER: undefined },
        { ASAAS_AMBIENTE: 'producao' }, { KIDMAIS_DEPLOY_ENV: 'production' }])
        assert.throws(() => opcoesConexao(alvo, { ...doCron, ...alteracao }, SERVICOS_TLS_MANUTENCAO), /TLS_REDE_PRIVADA_RECUSADA/, JSON.stringify(alteracao));
});

test('processo real: aguardando sai 0 sem conectar; configuração inválida sai 1 sem vazar a URL', () => {
    const script = path.join(__dirname, 'creditos-manutencao-cron.cjs');
    const limpo = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot };
    const a = spawnSync(process.execPath, [script], { env: { ...limpo, KIDMAIS_DEPLOY_ENV: 'staging', KIDMAIS_MANUTENCAO_MODO: 'aguardando' }, encoding: 'utf8' });
    assert.equal(a.status, 0);
    assert.deepEqual(JSON.parse(a.stdout.trim()), { estado: 'AGUARDANDO_HABILITACAO', conectou: false });
    const segredo = 'postgresql://usuario:SEGREDO123@outro-host:5432/kidmais_staging_1z91';
    const b = spawnSync(process.execPath, [script], { env: { ...limpo, ...env, KIDMAIS_RECONCILIAR_DATABASE_URL: segredo }, encoding: 'utf8' });
    assert.equal(b.status, 1);
    assert.ok(!(b.stdout + b.stderr).includes('SEGREDO123'), 'a URL não aparece na saída');
    assert.match(b.stderr, /Cron recusado/);
    // Só o motivo, sem o detalhe da conexão (host/alvo) que vem depois dos dois-pontos na mensagem do validarAlvo.
    const c = spawnSync(process.execPath, [script], { env: { ...limpo, ...env, KIDMAIS_RECONCILIAR_DATABASE_URL: segredo, KIDMAIS_RECONCILIAR_ALVO: 'x@y:1' }, encoding: 'utf8' });
    assert.equal(c.status, 1);
    assert.match(c.stderr, /Cron recusado \(ALVO_NAO_CONFIRMADO\)/);
    assert.ok(!(c.stdout + c.stderr).includes('outro-host') && !(c.stdout + c.stderr).includes('SEGREDO123'));
});

// ---- Rodada 2 (Astra r1, 04/11/2026) ----
const HOST = 'dpg-daidko3m8hqs73ce4jt0-a';
const SOBRESCRITAS = ['host=destino-fixture.invalid&port=6543', 'hostaddr=10.9.9.9', 'port=6543', 'dbname=outro', 'user=outro',
    'options=-c%20search_path%3Dx', 'application_name=x', 'HOST=destino-fixture.invalid'];

test('P2-1: parâmetro na URL que troca o destino é recusado no wrapper e na manutenção; os de TLS passam', () => {
    for (const q of SOBRESCRITAS)
        assert.throws(() => planejar({ ...env, KIDMAIS_RECONCILIAR_DATABASE_URL: URL_STAGING + '?' + q }), /parâmetro\(s\)/, q);
    assert.throws(() => planejar({ ...env, KIDMAIS_RECONCILIAR_DATABASE_URL: URL_STAGING + '#x' }), /fragmento/);
    const semPorta = 'postgresql://fixture@' + HOST + '/kidmais_staging_1z91';
    assert.throws(() => planejar({ ...env, KIDMAIS_RECONCILIAR_DATABASE_URL: semPorta }), /porta deve ser explícita/);
    const semUsuario = 'postgresql://' + HOST + ':5432/kidmais_staging_1z91';
    assert.throws(() => planejar({ ...env, KIDMAIS_RECONCILIAR_DATABASE_URL: semUsuario }), /usuário deve ser explícito/);
    assert.deepEqual(planejar({ ...env, KIDMAIS_RECONCILIAR_DATABASE_URL: URL_STAGING + '?sslmode=require' }), []);

    const base = { ...env, RENDER: 'true', KIDMAIS_RECONCILIAR_TLS: 'render-interno-criptografado', RENDER_SERVICE_ID: CRON_MANUTENCAO_STAGING };
    for (const q of SOBRESCRITAS) {
        const e = { ...base, KIDMAIS_RECONCILIAR_DATABASE_URL: URL_STAGING + '?' + q };
        assert.throws(() => conexaoDaManutencao(validarAlvo(e), e), /parâmetro\(s\)/, q);
    }
    const ok = conexaoDaManutencao(validarAlvo(base), base);
    assert.deepEqual(Object.keys(ok).sort(), ['database', 'host', 'password', 'port', 'ssl', 'user']);
    assert.equal(ok.host, HOST); assert.equal(ok.port, 5432); assert.equal(ok.database, 'kidmais_staging_1z91'); assert.equal(ok.user, 'fixture');
    assert.deepEqual(ok.ssl, { rejectUnauthorized: false, minVersion: 'TLSv1.2' });
    // Alvo adulterado depois da validação (connectionString diverge do host/banco conferidos): recusado pelo parser do driver.
    const adulterado = { ...validarAlvo(base), connectionString: 'postgresql://fixture@destino-fixture.invalid:5432/kidmais_staging_1z91' };
    assert.throws(() => conexaoDaManutencao(adulterado, { ...base, RENDER: undefined, KIDMAIS_RECONCILIAR_TLS: 'verificado' }), /diverge do alvo validado/);
});

test('P2-2: falha descrita só por etapa, tipo, código e motivo de lista fechada; nunca o texto', () => {
    const dns = Object.assign(new Error('getaddrinfo ENOTFOUND ' + HOST), { code: 'ENOTFOUND', hostname: HOST });
    const autenticacao = Object.assign(new Error('password authentication failed for user "usuario_secreto"'), { code: '28P01' });
    const semCodigo = new Error('connect to ' + HOST + ' as usuario_secreto: SEGREDO123');
    for (const [erro, codigo] of [[dns, 'ENOTFOUND'], [autenticacao, '28P01'], [semCodigo, null]]) {
        const d = falhaSegura(erro, 'conexao');
        const texto = JSON.stringify(d);
        assert.ok(!texto.includes(HOST) && !texto.includes('usuario_secreto') && !texto.includes('SEGREDO123'), texto);
        assert.deepEqual(d, { etapa: 'conexao', tipo: 'Error', codigo, motivo: null });
    }
    assert.equal(falhaSegura(new Error('Alvo recusado: o banco conectado não é o confirmado.'), 'identidade').motivo, 'BANCO_CONECTADO_DIVERGE');
    assert.equal(falhaSegura(new Error('Produção: escrita só com --autorizacao "<x>".'), 'configuracao').motivo, 'PRODUCAO_EXIGE_AUTORIZACAO');
    assert.equal(falhaSegura(new Error('x'), 'inventada').etapa, 'desconhecida');
});

test('P2-2 processo real: falha DEPOIS do spawn (conexão) e recusa na própria manutenção não vazam host, usuário nem senha', () => {
    const wrapper = path.join(__dirname, 'creditos-manutencao-cron.cjs');
    const manutencao = path.join(__dirname, 'creditos-manutencao.cjs');
    const limpo = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot };
    const url = 'postgresql://usuario_secreto:SEGREDO123@' + HOST + ':5432/kidmais_staging_1z91';
    const proibidos = [HOST, 'usuario_secreto', 'SEGREDO123'];
    // P3 (Astra, delta r2): sem depender da rede. Um preload (NODE_OPTIONS, herdado pelo filho) troca dns.lookup por uma falha
    // ENOTFOUND cuja mensagem leva o host, e grava um marcador provando que a resolução foi interceptada no processo filho.
    // Nenhum socket é aberto, mesmo num executor com acesso à rede privada do Render.
    const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'cron-manutencao-dns-'));
    const preload = path.join(pasta, 'dns-enotfound.cjs');
    const marcador = path.join(pasta, 'lookup-interceptado.txt');
    fs.writeFileSync(preload, [
        "const dns = require('node:dns');",
        'dns.lookup = function (host, opcoes, callback) {',
        "    const cb = typeof opcoes === 'function' ? opcoes : callback;",
        "    require('node:fs').appendFileSync(process.env.MARCADOR_LOOKUP, String(process.pid) + '\\n');",
        "    const erro = Object.assign(new Error('getaddrinfo ENOTFOUND ' + host), { code: 'ENOTFOUND', errno: -3008, syscall: 'getaddrinfo', hostname: host });",
        '    process.nextTick(() => cb(erro));',
        '};',
    ].join('\n'));
    try {
        const r = spawnSync(process.execPath, [wrapper], { encoding: 'utf8', timeout: 60_000,
            env: { ...limpo, ...env, KIDMAIS_RECONCILIAR_DATABASE_URL: url, NODE_OPTIONS: '--require ' + JSON.stringify(preload), MARCADOR_LOOKUP: marcador } });
        assert.equal(r.status, 1, r.stderr);
        const linha = JSON.parse(r.stderr.trim().split('\n').filter((l) => l.includes('MANUTENCAO_RECUSADA_OU_INTERROMPIDA')).pop());
        assert.deepEqual(linha.falha, { etapa: 'conexao', tipo: 'Error', codigo: 'ENOTFOUND', motivo: null });
        const pids = fs.readFileSync(marcador, 'utf8').trim().split('\n');
        assert.ok(pids.length >= 1 && !pids.includes(String(r.pid)), 'a resolução interceptada aconteceu no filho, não no wrapper');
        for (const p of proibidos) assert.ok(!(r.stdout + r.stderr).includes(p), p);
    } finally { fs.rmSync(pasta, { recursive: true, force: true }); }
    // Manutenção chamada direto (Web Shell, sem o wrapper) com sobrescrita de destino: recusa antes de conectar, sem texto.
    const d = spawnSync(process.execPath, [manutencao], { env: { ...limpo, ...env, KIDMAIS_RECONCILIAR_DATABASE_URL: url + '?host=destino-fixture.invalid&port=6543' }, encoding: 'utf8' });
    assert.equal(d.status, 1);
    assert.deepEqual(JSON.parse(d.stderr.trim()), { estado: 'MANUTENCAO_RECUSADA_OU_INTERROMPIDA',
        falha: { etapa: 'conexao-parametros', tipo: 'Error', codigo: null, motivo: 'PARAMETRO_DE_DESTINO' } });
    for (const p of [...proibidos, 'destino-fixture']) assert.ok(!(d.stdout + d.stderr).includes(p), p);
});
