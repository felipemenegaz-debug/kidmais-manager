/* eslint-disable @typescript-eslint/no-require-imports */
/** Job dos avisos (087): só configuração e alvo. Não conecta a banco nem envia e-mail. URLs sintéticas (senhas fictícias). */
const test = require('node:test');
const assert = require('node:assert/strict');
const { configuracaoExecucao, codigoDeSaida, recusarParametrosDeDestino, parametrosDeConexao, descreverFalha, motivoDe, registroDaFalha, cicloComEncerramento, FalhaDoCiclo, ETAPAS, MOTIVOS, TIPOS, STAGING, SCHEMA_EXIGIDO, PARAMETROS_TLS } = require('./assinatura-avisos.cjs');
const { PRODUCAO } = require('./assinatura-reconciliar.cjs');

const LOCAL = 'postgresql://u:p@127.0.0.1:55599/kidmais_avisos_descartavel';
const REMOTO = 'postgresql://u:p@dpg-exemplo-a:5432/kidmais_staging_exemplo';
const URL_PROD = `postgresql://u:senha-ficticia@${PRODUCAO.host}:${PRODUCAO.port}/${PRODUCAO.database}`;
const URL_STG = `postgresql://u:senha-ficticia@${STAGING.host}:${STAGING.port}/${STAGING.database}`;
const env = (url, extra = {}) => ({ KIDMAIS_RECONCILIAR_DATABASE_URL: url, KIDMAIS_RECONCILIAR_ALVO: `${new URL(url).pathname.slice(1)}@${new URL(url).hostname}:${new URL(url).port || 5432}`, ...extra });
const PROD = Object.freeze({ RENDER: 'true', KIDMAIS_DEPLOY_ENV: 'production', ASAAS_AMBIENTE: 'producao', DATABASE_SSL: 'true', DATABASE_SSL_REJECT_UNAUTHORIZED: 'false',
    EMAIL_PROVIDER: 'resend', ASSINATURA_AVISOS_EMAIL: 'ligado', KIDMAIS_AVISOS_MODO: 'aplicar', KIDMAIS_AVISOS_SCHEMA_VALIDADO: SCHEMA_EXIGIDO });
const STG = Object.freeze({ ...PROD, KIDMAIS_DEPLOY_ENV: 'staging', ASAAS_AMBIENTE: 'sandbox', DATABASE_SSL: 'false' });

test('simulação é o padrão e aceita alvo confirmado; argumento desconhecido é recusado', () => {
    assert.deepEqual(configuracaoExecucao(env(LOCAL), []).aplicar, false);
    assert.equal(configuracaoExecucao(env(REMOTO), []).modo, 'SIMULACAO_SEM_ESCRITA');
    assert.throws(() => configuracaoExecucao(env(LOCAL), ['--forcar']), /Argumento desconhecido/);
});

test('aguardando: sai sem conectar, sem exigir alvo nem --aplicar validado', () => {
    const r = configuracaoExecucao({ KIDMAIS_AVISOS_MODO: 'aguardando' }, ['--aplicar']);
    assert.deepEqual(r, { aguardando: true, aplicar: false, alvo: null, modo: 'AGUARDANDO_HABILITACAO' });
});

test('--aplicar local: só banco local, e-mail em arquivo e a trava ligada', () => {
    const ok = { EMAIL_PROVIDER: 'arquivo', ASSINATURA_AVISOS_EMAIL: 'ligado' };
    assert.equal(configuracaoExecucao(env(LOCAL, ok), ['--aplicar']).modo, 'APLICAR_LOCAL_EMAIL_ARQUIVO');
    assert.throws(() => configuracaoExecucao(env(LOCAL, { ...ok, EMAIL_PROVIDER: 'resend' }), ['--aplicar']), /e-mail em arquivo/);
    assert.throws(() => configuracaoExecucao(env(LOCAL, { EMAIL_PROVIDER: 'arquivo' }), ['--aplicar']), /ASSINATURA_AVISOS_EMAIL=ligado/);
    // Remoto genérico (fora do Render) continua recusado, com ou sem e-mail em arquivo.
    assert.throws(() => configuracaoExecucao(env(REMOTO, ok), ['--aplicar']), /serviço do Render/);
});

test('--aplicar em production (P2-2): só no Render, alvo exato, resend, trava, modo e schema liberados', () => {
    assert.equal(configuracaoExecucao(env(URL_PROD, PROD), ['--aplicar']).modo, 'APLICAR_PRODUCAO');
    const casos = [
        // Sem RENDER a própria trava de alvo da reconciliação já recusa o banco de produção (antes da regra deste job).
        [{ RENDER: undefined }, /alvo exato, o serviço e o provedor de produção/],
        // (simular deixou de ser recusa: é simulação só leitura mesmo com --aplicar; ver o teste do P3 #6.)
        [{ KIDMAIS_AVISOS_MODO: undefined }, /KIDMAIS_AVISOS_MODO=aplicar/],
        [{ KIDMAIS_AVISOS_SCHEMA_VALIDADO: undefined }, /Schema não liberado/],
        [{ KIDMAIS_AVISOS_SCHEMA_VALIDADO: '086' }, /Schema não liberado/],
        [{ EMAIL_PROVIDER: 'arquivo' }, /EMAIL_PROVIDER=resend/],
        [{ ASSINATURA_AVISOS_EMAIL: 'desligado' }, /ASSINATURA_AVISOS_EMAIL=ligado/],
        // Banco de produção declarado como staging: a trava compartilhada recusa antes (exige KIDMAIS_DEPLOY_ENV=production).
        [{ KIDMAIS_DEPLOY_ENV: 'staging' }, /recusado/],
        [{ ASAAS_AMBIENTE: 'sandbox' }, /alvo exato, o serviço e o provedor de produção/],
    ];
    for (const [extra, re] of casos) {
        const e = { ...env(URL_PROD, PROD), ...extra };
        for (const k of Object.keys(extra)) if (extra[k] === undefined) delete e[k];
        assert.throws(() => configuracaoExecucao(e, ['--aplicar']), re, JSON.stringify(extra));
    }
    // Ambiente desconhecido com banco remoto que passa pela trava de alvo: recusado pela regra deste job.
    assert.throws(() => configuracaoExecucao(env(REMOTO, { ...PROD, KIDMAIS_DEPLOY_ENV: 'homolog', ASAAS_AMBIENTE: 'sandbox' }), ['--aplicar']), /Ambiente recusado/);
    // Banco remoto que NÃO é o de produção, com todas as envs de production: recusado por este job (M19 da bateria de mutantes).
    assert.throws(() => configuracaoExecucao(env(REMOTO, PROD), ['--aplicar']), /Alvo de produção recusado/);
    // Banco de produção com nome certo em host errado: a trava de alvo da reconciliação recusa antes.
    const outroHost = `postgresql://u:senha-ficticia@dpg-outro-a:5432/${PRODUCAO.database}`;
    assert.throws(() => configuracaoExecucao(env(outroHost, PROD), ['--aplicar']), /alvo exato/);
    // Simulação em production continua aceita sem modo/schema (não grava).
    assert.equal(configuracaoExecucao(env(URL_PROD, { RENDER: 'true', KIDMAIS_DEPLOY_ENV: 'production', ASAAS_AMBIENTE: 'producao' }), []).modo, 'SIMULACAO_SEM_ESCRITA');
});

test('--aplicar em staging: alvo exato do banco de staging; produção no ambiente staging é recusada', () => {
    assert.equal(configuracaoExecucao(env(URL_STG, STG), ['--aplicar']).modo, 'APLICAR_STAGING');
    assert.throws(() => configuracaoExecucao(env(REMOTO, STG), ['--aplicar']), /Alvo de staging recusado/);
    // Banco de produção com KIDMAIS_DEPLOY_ENV=staging: a trava de alvo da reconciliação recusa antes (exige o serviço de produção).
    assert.throws(() => configuracaoExecucao(env(URL_PROD, { ...STG, ASAAS_AMBIENTE: 'producao' }), ['--aplicar']), /recusado/);
});

test('alvo sempre explícito: sem confirmação, banco proibido ou DATABASE_URL do serviço é recusado', () => {
    assert.throws(() => configuracaoExecucao({ KIDMAIS_RECONCILIAR_DATABASE_URL: LOCAL }, []), /Confirme o alvo/);
    assert.throws(() => configuracaoExecucao({}, []), /KIDMAIS_RECONCILIAR_DATABASE_URL/);
    assert.throws(() => configuracaoExecucao(env('postgresql://u:p@127.0.0.1:5432/kidmais_manager'), []), /recusado/);
    assert.throws(() => configuracaoExecucao({ ...env(LOCAL), DATABASE_URL: LOCAL }, []), /não a DATABASE_URL/);
    assert.throws(() => configuracaoExecucao({ ...env(URL_PROD, PROD), DATABASE_URL: URL_PROD }, ['--aplicar']), /não a DATABASE_URL/);
});

test('P2 #5 (Astra 03/11): parâmetros da URL que trocam o destino são recusados antes de conectar; só os de TLS passam', () => {
    const casos = ['?host=outro-banco.example', '?port=6543', '?host=outro-banco.example&port=6543', '?hostaddr=10.0.0.9', '?dbname=outro',
        '?options=-c%20search_path%3Dx', '?sslmode=require&host=outro-banco.example', '?HOST=outro-banco.example', '?host=a&host=b', '#frag',
        '?application_name=x', '?user=outro', '?sslmode=require#x'];
    for (const sufixo of casos) {
        const re = sufixo.includes('#') ? /fragmento/ : /podem substituir o destino/;
        assert.throws(() => configuracaoExecucao(env(URL_PROD + sufixo, PROD), ['--aplicar']), re, `production ${sufixo}`);
        assert.throws(() => configuracaoExecucao(env(URL_STG + sufixo, STG), ['--aplicar']), re, `staging ${sufixo}`);
        assert.throws(() => configuracaoExecucao(env(LOCAL + sufixo), []), re, `simulação local ${sufixo}`);
        assert.throws(() => recusarParametrosDeDestino(URL_PROD + sufixo), re);
    }
    // A mensagem nunca carrega a URL nem valores: só nomes de parâmetro, saneados.
    assert.throws(() => recusarParametrosDeDestino(URL_PROD + '?host=segredo.example&x%3Cy=1'), (e) => !/segredo|senha-ficticia/.test(e.message) && /host, x\?y/.test(e.message));
    // Parâmetros de TLS (os que opcoesConexao trata) continuam aceitos — só em minúsculas, como opcoesConexao os remove (r4.1).
    for (const p of [...PARAMETROS_TLS]) assert.doesNotThrow(() => recusarParametrosDeDestino(`${URL_PROD}?${p}=x`), p);
    assert.equal(configuracaoExecucao(env(URL_PROD + '?sslmode=require', PROD), ['--aplicar']).modo, 'APLICAR_PRODUCAO');
    assert.equal(configuracaoExecucao(env(URL_STG + '?sslmode=require', STG), ['--aplicar']).modo, 'APLICAR_STAGING');
    assert.throws(() => configuracaoExecucao(env(URL_STG + '?SSLMODE=require', STG), ['--aplicar']), /podem substituir o destino/, 'caixa alta não é TLS para opcoesConexao');
    // Aguardando não valida a URL (não conecta); a recusa vale a partir de simular.
    assert.equal(configuracaoExecucao({ KIDMAIS_AVISOS_MODO: 'aguardando', KIDMAIS_RECONCILIAR_DATABASE_URL: URL_PROD + '?host=x' }, ['--aplicar']).modo, 'AGUARDANDO_HABILITACAO');
});

test('P3 #6 (Astra 03/11): com o comando fixo do cron (--aplicar), KIDMAIS_AVISOS_MODO decide aguardando → simular → aplicar; modo desconhecido recusa', () => {
    const comando = ['--aplicar'];
    assert.equal(configuracaoExecucao(env(URL_PROD, { ...PROD, KIDMAIS_AVISOS_MODO: 'aguardando' }), comando).modo, 'AGUARDANDO_HABILITACAO');
    const sim = configuracaoExecucao(env(URL_PROD, { ...PROD, KIDMAIS_AVISOS_MODO: 'simular' }), comando);
    assert.equal(sim.modo, 'SIMULACAO_SEM_ESCRITA'); assert.equal(sim.aplicar, false); assert.equal(sim.alvo.database, PRODUCAO.database);
    // simular não exige schema, provedor nem trava (não grava nem envia), mas exige alvo válido e sem parâmetros de destino.
    assert.equal(configuracaoExecucao(env(URL_PROD, { RENDER: 'true', KIDMAIS_DEPLOY_ENV: 'production', ASAAS_AMBIENTE: 'producao', KIDMAIS_AVISOS_MODO: 'simular' }), comando).modo, 'SIMULACAO_SEM_ESCRITA');
    assert.throws(() => configuracaoExecucao(env(URL_PROD + '?host=x', { ...PROD, KIDMAIS_AVISOS_MODO: 'simular' }), comando), /podem substituir o destino/);
    assert.equal(configuracaoExecucao(env(URL_PROD, PROD), comando).modo, 'APLICAR_PRODUCAO');
    for (const m of ['conferir', 'APLICAR', 'sim', 'true']) assert.throws(() => configuracaoExecucao(env(URL_PROD, { ...PROD, KIDMAIS_AVISOS_MODO: m }), comando), /KIDMAIS_AVISOS_MODO desconhecido/, m);
    // Local sem modo definido continua como antes.
    assert.equal(configuracaoExecucao(env(LOCAL, { EMAIL_PROVIDER: 'arquivo', ASSINATURA_AVISOS_EMAIL: 'ligado' }), comando).modo, 'APLICAR_LOCAL_EMAIL_ARQUIVO');
});

test('P2 #7 (Astra r3): porta e usuário explícitos na URL; conexão montada só pelo alvo validado, imune a PGPORT/PGHOST/PGDATABASE/PGUSER', () => {
    const semPorta = `postgresql://u:senha-ficticia@${PRODUCAO.host}/${PRODUCAO.database}`;
    const envSemPorta = { KIDMAIS_RECONCILIAR_DATABASE_URL: semPorta, KIDMAIS_RECONCILIAR_ALVO: `${PRODUCAO.database}@${PRODUCAO.host}:5432`, ...PROD, PGPORT: '6543' };
    // A reprodução do Astra: URL sem porta + PGPORT=6543 passava pela validação como 5432. Agora recusa antes de conectar, em todo modo que conecta.
    assert.throws(() => configuracaoExecucao(envSemPorta, ['--aplicar']), /porta deve ser explícita/);
    assert.throws(() => configuracaoExecucao({ ...envSemPorta, KIDMAIS_AVISOS_MODO: 'simular' }, ['--aplicar']), /porta deve ser explícita/);
    assert.throws(() => configuracaoExecucao(env(`postgresql://u:p@${STAGING.host}/${STAGING.database}`, STG), ['--aplicar']), /porta deve ser explícita/);
    assert.throws(() => configuracaoExecucao(env('postgresql://u:p@127.0.0.1/kidmais_avisos_descartavel'), []), /porta deve ser explícita/);
    assert.throws(() => configuracaoExecucao(env(`postgresql://${PRODUCAO.host}:5432/${PRODUCAO.database}`, PROD), ['--aplicar']), /usuário deve ser explícito/);
    // Parâmetros efetivos: só do alvo validado; nunca a connectionString; PG* do ambiente não entram.
    const cfg = configuracaoExecucao(env(URL_PROD, PROD), ['--aplicar']);
    const p = parametrosDeConexao(cfg.alvo, { ...PROD, PGPORT: '6543', PGHOST: 'outro.example', PGDATABASE: 'outro', PGUSER: 'outro', PGPASSWORD: 'x' });
    assert.deepEqual({ host: p.host, port: p.port, database: p.database, user: p.user, password: p.password }, { host: PRODUCAO.host, port: 5432, database: PRODUCAO.database, user: 'u', password: 'senha-ficticia' });
    assert.equal('connectionString' in p, false); assert.equal(typeof p.ssl, 'object'); assert.equal(p.ssl.minVersion, 'TLSv1.2');
    // O que o driver fará com esses parâmetros, sem conectar: porta e host explícitos vencem PGPORT/PGHOST.
    const { Client } = require('pg');
    const antes = { PGPORT: process.env.PGPORT, PGHOST: process.env.PGHOST };
    process.env.PGPORT = '6543'; process.env.PGHOST = 'outro.example';
    try {
        const c = new Client(p);
        assert.equal(c.connectionParameters.port, 5432); assert.equal(c.connectionParameters.host, PRODUCAO.host); assert.equal(c.connectionParameters.database, PRODUCAO.database);
    } finally {
        for (const k of Object.keys(antes)) { if (antes[k] === undefined) delete process.env[k]; else process.env[k] = antes[k]; }
    }
    // Staging e local pelo mesmo caminho; production sem DATABASE_SSL=true é recusada por opcoesConexao.
    const stg = parametrosDeConexao(configuracaoExecucao(env(URL_STG, STG), ['--aplicar']).alvo, STG);
    assert.deepEqual([stg.host, stg.port, stg.database], [STAGING.host, STAGING.port, STAGING.database]);
    const loc = parametrosDeConexao(configuracaoExecucao(env(LOCAL), []).alvo, {});
    assert.deepEqual([loc.host, loc.port, loc.database, loc.ssl], ['127.0.0.1', 55599, 'kidmais_avisos_descartavel', false]);
    assert.throws(() => parametrosDeConexao(cfg.alvo, { ...PROD, DATABASE_SSL: 'false' }), /TLS_PRODUCAO_RECUSADO/);
    // Alvo adulterado depois da validação (defesa em profundidade): divergência host/porta/banco é recusada pelo parser do driver.
    assert.throws(() => parametrosDeConexao({ ...cfg.alvo, port: 6543 }, PROD), /diverge do alvo validado/);
    assert.throws(() => parametrosDeConexao({ ...cfg.alvo, database: 'outro' }, PROD), /diverge do alvo validado/);
});

test('P3 #8 e #9 (Astra r4): porta 0/fora da faixa recusada em todo modo; parser só vê a URL sanitizada (sslcert/sslkey/sslrootcert/verify-ca+libpq não são lidos nem exigidos)', () => {
    // #8: porta zero (o driver a trataria como ausente e cairia em PGPORT) e 65536 — local, simulação remota, staging e production.
    // (portas > 65535 nem passam pelo parser de URL do Node: a recusa aqui cobre o zero, que o parser aceita e o driver descarta.)
    for (const porta of ['0', '00']) {
        const re = /porta fora de 1\.\.65535/;
        assert.throws(() => configuracaoExecucao(env(`postgresql://u:p@127.0.0.1:${porta}/kidmais_avisos_descartavel`, { EMAIL_PROVIDER: 'arquivo', ASSINATURA_AVISOS_EMAIL: 'ligado', PGPORT: '6543' }), ['--aplicar']), re, `local ${porta}`);
        assert.throws(() => configuracaoExecucao(env(`postgresql://u:p@dpg-exemplo-a:${porta}/kidmais_staging_exemplo`, { PGPORT: '6543' }), []), re, `simulação remota ${porta}`);
    }
    assert.throws(() => parametrosDeConexao({ ...configuracaoExecucao(env(URL_PROD, PROD), ['--aplicar']).alvo, port: 0 }, PROD), /porta fora de 1\.\.65535/, 'defesa em profundidade');
    assert.throws(() => parametrosDeConexao({ ...configuracaoExecucao(env(URL_PROD, PROD), ['--aplicar']).alvo, port: 5432.5 }, PROD), /porta fora de 1\.\.65535/);
    // #9: parâmetros TLS de arquivo apontando para caminho inexistente e verify-ca+uselibpqcompat: a política decide o ssl e
    // o parser só vê a URL sanitizada — nenhum ENOENT, nenhuma exigência de CA, mesmos parâmetros efetivos.
    const esperado = { host: PRODUCAO.host, port: 5432, database: PRODUCAO.database, user: 'u', password: 'senha-ficticia' };
    for (const sufixo of ['?sslcert=C:/astra-inexistente.pem', '?sslkey=C:/astra-inexistente.pem', '?sslrootcert=C:/astra-inexistente.pem',
        '?sslmode=verify-ca&uselibpqcompat=true', '?sslmode=require&sslrootcert=/nao/existe.pem']) {
        const cfg = configuracaoExecucao(env(URL_PROD + sufixo, PROD), ['--aplicar']);
        assert.equal(cfg.modo, 'APLICAR_PRODUCAO', sufixo);
        const p = parametrosDeConexao(cfg.alvo, PROD);
        assert.deepEqual({ host: p.host, port: p.port, database: p.database, user: p.user, password: p.password }, esperado, sufixo);
        assert.deepEqual(p.ssl, { rejectUnauthorized: false, minVersion: 'TLSv1.2' }, `ssl pela política, não pela URL: ${sufixo}`);
        assert.equal('connectionString' in p, false);
    }
    // Simulação local com sslcert inexistente também não lê o arquivo.
    const loc = parametrosDeConexao(configuracaoExecucao(env(LOCAL + '?sslcert=C:/astra-inexistente.pem'), []).alvo, {});
    assert.deepEqual([loc.host, loc.port, loc.ssl], ['127.0.0.1', 55599, false]);
});

test('código de saída: 1 sem a 087, 2 com atenção humana, 0 caso contrário', () => {
    assert.equal(codigoDeSaida({ instalado: false }, () => false), 1);
    assert.equal(codigoDeSaida({ instalado: true }, () => true), 2);
    assert.equal(codigoDeSaida({ instalado: true }, () => false), 0);
});

test('falha registrada r2 (P2 #1): motivo é só um código fechado; o texto da mensagem (argv, nomes de parâmetro, URL) nunca sai', () => {
    const SENHA = 'senhaSecreta123';
    const URL_FALSA = `postgresql://usuario_falso:${SENHA}@dpg-dak750gae00c73fudmg0-a:5432/kidmais_production`;
    const sai = (d) => JSON.stringify(d);
    // Argumento externo: antes o texto do argv ia ao log.
    const argv = (() => { try { configuracaoExecucao({}, [`--senha=${SENHA}`]); } catch (e) { return e; } })();
    const dArgv = descreverFalha(argv, 'configuracao');
    assert.deepEqual(dArgv, { etapa: 'configuracao', tipo: 'Error', codigo: null, motivo: 'ARGUMENTO_DESCONHECIDO' });
    assert.doesNotMatch(sai(dArgv), new RegExp(SENHA));
    // Nomes de parâmetro da URL: antes iam no motivo.
    const param = (() => { try { recusarParametrosDeDestino(`${URL_FALSA}?host_${SENHA}=x`); } catch (e) { return e; } })();
    assert.match(param.message, new RegExp(SENHA), 'a mensagem crua carregaria o nome');
    const dParam = descreverFalha(param, 'configuracao');
    assert.equal(dParam.motivo, 'PARAMETRO_DE_DESTINO');
    assert.doesNotMatch(sai(dParam), new RegExp(SENHA));
    // Mensagem conhecida com texto anexado: só o código; a URL e a senha não saem.
    const anexada = descreverFalha(new Error(`URL do alvo recusada: a porta deve ser explícita. ${URL_FALSA}`), 'configuracao');
    assert.equal(anexada.motivo, 'PORTA_AUSENTE');
    assert.doesNotMatch(sai(anexada), new RegExp(SENHA));
    assert.doesNotMatch(sai(anexada), /postgresql/);
    // Erro externo (driver): sem motivo, só código SQLSTATE.
    const driver = Object.assign(new Error(`password authentication failed for user "x" ${URL_FALSA}`), { code: '28P01' });
    assert.deepEqual(descreverFalha(driver, 'conexao'), { etapa: 'conexao', tipo: 'Error', codigo: '28P01', motivo: null });
    // O caso real de 03/11 (origem dos links ausente).
    assert.deepEqual(descreverFalha(Object.assign(new Error('Origem administrativa não configurada'), { code: 'EMAIL_NAO_CONFIGURADO' }), 'dependencias'),
        { etapa: 'dependencias', tipo: 'Error', codigo: 'EMAIL_NAO_CONFIGURADO', motivo: null });
    // Mensagem que só COMEÇA diferente não casa (âncora no início).
    assert.equal(motivoDe(new Error(`${SENHA} Argumento desconhecido: x`)), null);
    assert.equal(motivoDe(null), null);
    assert.equal(motivoDe({ message: 42 }), null);
    // Todo motivo emitido é um dos códigos do catálogo, e os códigos são únicos e em formato fechado.
    const codigos = MOTIVOS.map(([c]) => c);
    assert.equal(new Set(codigos).size, codigos.length);
    for (const c of codigos) assert.match(c, /^[A-Z][A-Z_]+$/);
    // Códigos: formatos aceitos e recusados.
    for (const ok of ['28P01', '57P01', 'ECONNREFUSED', 'ETIMEDOUT', 'ERR_TLS_CERT_ALTNAME_INVALID', 'SELF_SIGNED_CERT_IN_CHAIN', 'EMAIL_NAO_CONFIGURADO'])
        assert.equal(descreverFalha(Object.assign(new Error('x'), { code: ok }), 'conexao').codigo, ok, ok);
    for (const ruim of [URL_FALSA, SENHA, 'senha', 'abc_def', 'X', 'A'.repeat(61), 'A_' + 'B'.repeat(60), 42, null])
        assert.equal(descreverFalha(Object.assign(new Error('x'), { code: ruim }), 'conexao').codigo, null, String(ruim));
    // Tipos: lista fechada; construtor arbitrário vira 'Outro'; não-objeto vira 'NaoErro'.
    assert.equal(descreverFalha(new URIError('x'), 'execucao').tipo, 'URIError');
    class SegredoNoNome extends Error {}
    assert.equal(descreverFalha(new SegredoNoNome('x'), 'execucao').tipo, 'Outro');
    assert.equal(descreverFalha('texto solto ' + SENHA, 'execucao').tipo, 'NaoErro');
    assert.doesNotMatch(sai(descreverFalha('texto solto ' + SENHA, 'execucao')), new RegExp(SENHA));
    assert.deepEqual(descreverFalha(null, 'execucao'), { etapa: 'execucao', tipo: 'NaoErro', codigo: null, motivo: null });
    assert.ok(TIPOS.includes('DatabaseError'));
    // Etapa fora da lista.
    assert.equal(descreverFalha(new Error('x'), 'inventada').etapa, 'desconhecida');
    assert.deepEqual(Object.keys(descreverFalha(new Error('x'), ETAPAS[0])).sort(), ['codigo', 'etapa', 'motivo', 'tipo']);
});

test('falha registrada r2 (P2 #2): corpo e encerramento — só corpo, só encerramento, ambos', async () => {
    const erroCorpo = Object.assign(new Error('Conexão remota sem TLS recusada.'), {});
    const erroFim = Object.assign(new Error('Connection terminated unexpectedly'), { code: 'ECONNRESET' });
    const capturar = async (p) => { try { await p; } catch (e) { return e; } assert.fail('deveria falhar'); };
    // Sem falha: devolve o resultado e encerra uma vez.
    let encerrou = 0;
    assert.equal(await cicloComEncerramento({ etapa: 'execucao' }, async () => 'ok', async () => { encerrou++; }), 'ok');
    assert.equal(encerrou, 1);
    // 1) Só o corpo falha: principal com a etapa do corpo; encerramento ainda roda; sem secundária.
    encerrou = 0;
    const estado1 = { etapa: 'conexao' };
    const f1 = await capturar(cicloComEncerramento(estado1, async () => { estado1.etapa = 'identidade'; throw erroCorpo; }, async () => { encerrou++; }));
    assert.ok(f1 instanceof FalhaDoCiclo);
    assert.equal(encerrou, 1);
    assert.deepEqual(registroDaFalha(f1, 'qualquer'), { falha: { etapa: 'identidade', tipo: 'Error', codigo: null, motivo: 'CONEXAO_SEM_TLS' } });
    // 2) Só o encerramento falha: principal na etapa 'encerramento'.
    const f2 = await capturar(cicloComEncerramento({ etapa: 'execucao' }, async () => 'ok', async () => { throw erroFim; }));
    assert.deepEqual(registroDaFalha(f2, 'execucao'), { falha: { etapa: 'encerramento', tipo: 'Error', codigo: 'ECONNRESET', motivo: null } });
    // 3) Ambos: a do corpo continua principal (erro e etapa originais); a do encerramento vai separada.
    const estado3 = { etapa: 'execucao' };
    const f3 = await capturar(cicloComEncerramento(estado3, async () => { throw Object.assign(new Error('relation x'), { code: '42P01' }); }, async () => { throw erroFim; }));
    assert.deepEqual(registroDaFalha(f3, estado3.etapa), {
        falha: { etapa: 'execucao', tipo: 'Error', codigo: '42P01', motivo: null },
        secundaria: { etapa: 'encerramento', tipo: 'Error', codigo: 'ECONNRESET', motivo: null },
    });
    // Falha fora do ciclo (antes do pool): registro simples com a etapa corrente.
    assert.deepEqual(registroDaFalha(new Error('E-mail do ambiente não configurado.'), 'email'),
        { falha: { etapa: 'email', tipo: 'Error', codigo: null, motivo: 'EMAIL_NAO_CONFIGURADO' } });
});

test('falha registrada r2 (P3 #3): exceção do parser do driver vira mensagem própria fixa, sem a senha', () => {
    const SENHA = 'SEGREDOparser';
    // %E0%A4 é escape hexadecimal válido mas UTF-8 incompleto: decodeURIComponent do pg-connection-string lança URIError.
    const url = `postgresql://u:%E0%A4${SENHA}@127.0.0.1:55599/kidmais_avisos_descartavel`;
    assert.throws(() => require('pg-connection-string').parse(url), URIError, 'premissa: o parser cru lança');
    const alvo = configuracaoExecucao(env(url), []).alvo;
    const erro = (() => { try { parametrosDeConexao(alvo, {}); } catch (e) { return e; } })();
    assert.ok(erro);
    assert.equal(erro.constructor, Error);
    assert.equal(erro.message, 'URL do alvo ilegível.');
    assert.deepEqual(descreverFalha(erro, 'conexao-parametros'), { etapa: 'conexao-parametros', tipo: 'Error', codigo: null, motivo: 'URL_ILEGIVEL' });
});

test('falha registrada r2: o script real imprime etapa e código do motivo, sem a senha nem o texto', () => {
    const { spawnSync } = require('node:child_process');
    const SENHA = 'senhaSecreta123';
    const base = {
        PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT,
        RENDER: 'true', NODE_ENV: 'production', KIDMAIS_DEPLOY_ENV: 'production', KIDMAIS_AVISOS_MODO: 'simular',
        KIDMAIS_RECONCILIAR_ALVO: 'kidmais_production@dpg-dak750gae00c73fudmg0-a:5432',
        KIDMAIS_RECONCILIAR_DATABASE_URL: `postgresql://usuario_falso:${SENHA}@dpg-dak750gae00c73fudmg0-a/kidmais_production`,
        DATABASE_SSL: 'true', DATABASE_SSL_REJECT_UNAUTHORIZED: 'false', ASAAS_AMBIENTE: 'producao',
    };
    const rodar = (argv) => spawnSync(process.execPath, ['--experimental-strip-types', require('node:path').join(__dirname, 'assinatura-avisos.cjs'), ...argv], { env: base, encoding: 'utf8', timeout: 20000 });
    for (const [argv, motivo] of [[['--aplicar'], 'PORTA_AUSENTE'], [[`--senha=${SENHA}`], 'ARGUMENTO_DESCONHECIDO']]) {
        const r = rodar(argv);
        assert.equal(r.status, 1);
        const linha = r.stderr.split('\n').find((l) => l.startsWith('{"falha"'));
        assert.ok(linha, r.stderr);
        assert.deepEqual(JSON.parse(linha), { falha: { etapa: 'configuracao', tipo: 'Error', codigo: null, motivo } });
        assert.doesNotMatch(r.stderr + r.stdout, new RegExp(SENHA));
        assert.doesNotMatch(r.stderr, /porta deve ser explícita|Argumento desconhecido/);
    }
});
