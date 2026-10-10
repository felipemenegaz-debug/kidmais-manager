/* eslint-disable @typescript-eslint/no-require-imports */
// Testes offline das guardas do executor de concorrência (Etapa 4): sem banco, sem rede, sem .env.
// Nenhum caso aqui chega a abrir conexão: toda recusa ocorre antes do driver.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const x = require('./concorrencia-vagas-isolado.cjs');

const ARQUIVO = path.join(__dirname, 'concorrencia-vagas-isolado.cjs');
const RAIZ = path.resolve(__dirname, '..');
const fonte = fs.readFileSync(ARQUIVO, 'utf8');
const VALIDO = '127.0.0.1:55480/kidmais_concorrencia_vagas_20261010';
const env = (valor, extra = {}) => ({[x.VAR_AUTORIZACAO]:valor, ...extra});
const recusaDe = (fn) => { try { fn(); } catch (e) { return e.codigo ?? e.message; } return 'ACEITO'; };
const rodar = (args, extraEnv = {}, cwd = RAIZ) => spawnSync(process.execPath, [ARQUIVO, ...args],
    {encoding:'utf8', cwd, env:{PATH:process.env.PATH, SystemRoot:process.env.SystemRoot, ...extraEnv}, timeout:30000});

test('modo: sem argumento ou --plano é offline; execução exige a flag única e sozinha', () => {
    assert.equal(x.modo([]), 'PLANO');
    assert.equal(x.modo(['--plano']), 'PLANO');
    assert.equal(x.modo([x.FLAG]), 'EXECUTAR');
    for (const argv of [[x.FLAG, '--plano'], [x.FLAG, x.FLAG], ['--concorrencia-isolada'], ['--fundador-rodada-2-autorizada'], ['--executar'], [x.FLAG, 'x']])
        assert.equal(x.modo(argv), null, JSON.stringify(argv));
});

test('alvo literal: aceita só 127.0.0.1/localhost, porta explícita e banco kidmais_concorrencia_*', () => {
    assert.deepEqual({...x.alvo(env(VALIDO))}, {host:'127.0.0.1', porta:55480, banco:'kidmais_concorrencia_vagas_20261010'});
    assert.deepEqual({...x.alvo(env('localhost:55480/kidmais_concorrencia_vagas_20261010'))}, {host:'127.0.0.1', porta:55480, banco:'kidmais_concorrencia_vagas_20261010'},
        'localhost é normalizado para 127.0.0.1 (o servidor confirma o endereço depois)');
    assert.equal(recusaDe(() => x.alvo({})), 'AUTORIZACAO_AUSENTE');
    assert.equal(recusaDe(() => x.alvo(env(''))), 'AUTORIZACAO_AUSENTE');
    for (const v of ['postgresql://u:s@127.0.0.1:55480/kidmais_concorrencia_x', '127.0.0.1/kidmais_concorrencia_x', '127.0.0.1:55480',
        '[::1]:55480/kidmais_concorrencia_x', '127.0.0.1:55480/kidmais_concorrencia_x?sslmode=disable', '127.0.0.1:55480/a/b', '127.0.0.1:55480/kidmais_concorrencia_x;drop'])
        assert.equal(recusaDe(() => x.alvo(env(v))), 'AUTORIZACAO_MALFORMADA', v);
});

test('alvo: recusa hosts remotos, staging, produção e qualquer nome fora do padrão', () => {
    for (const host of ['10.0.0.5', '192.168.0.10', 'db.example.com', 'dpg-daidko3m8hqs73ce4jt0-a', 'dpg-dak750gae00c73fudmg0-a', '0.0.0.0', '127.0.0.2'])
        assert.equal(recusaDe(() => x.alvo(env(`${host}:55480/kidmais_concorrencia_x`))), 'HOST_RECUSADO', host);
    for (const banco of ['kidmais_manager', 'kidmais_staging_1z91', 'kidmais_production', 'KIDMAIS_MANAGER', 'Kidmais_Production',
        'kidmais_concorrencia_kidmais_manager', 'kidmais_concorrencia_copia_kidmais_production'])
        assert.equal(recusaDe(() => x.alvo(env(`127.0.0.1:55480/${banco}`))), 'BANCO_PROIBIDO', banco);
    assert.deepEqual([...x.BANCOS_PROIBIDOS], ['kidmais_manager', 'kidmais_staging_1z91', 'kidmais_production']);
    for (const banco of ['postgres', 'template1', 'kidmais_pacotes_v1_descartavel', 'kidmais_renovacao_075_completa', 'kidmais_concorrencia_',
        'Kidmais_concorrencia_x', 'kidmais_concorrencia_X', 'kidmais_concorrencia_' + 'a'.repeat(41)])
        assert.equal(recusaDe(() => x.alvo(env(`127.0.0.1:55480/${banco}`))), 'BANCO_FORA_DO_PADRAO', banco);
    for (const porta of ['5432', '80', '1023', '65536', '70000', '0'])
        assert.equal(recusaDe(() => x.alvo(env(`127.0.0.1:${porta}/kidmais_concorrencia_x`))), 'PORTA_RECUSADA', porta);
});

test('configuração de conexão herdada (DATABASE_URL e qualquer PG*) é recusada', () => {
    for (const nome of ['DATABASE_URL', 'PGHOST', 'PGPORT', 'PGDATABASE', 'PGPASSWORD', 'pgpassword', 'PGSERVICE', 'PGPASSFILE', 'PGOPTIONS'])
        assert.match(recusaDe(() => x.semConexaoHerdada({[nome]:'qualquer'})), /^CONEXAO_HERDADA/, nome);
    assert.doesNotThrow(() => x.semConexaoHerdada({PATH:'x', KIDMAIS_CONCORRENCIA_AUTORIZACAO:VALIDO, DATABASE_SSL:'false'}));
});

test('identidade: banco, papel, endereço, porta, cluster_name e cluster sem nenhum outro banco', () => {
    const a = x.alvo(env(VALIDO));
    const linha = {db:a.banco, papel:x.PAPEL, endereco:'127.0.0.1', porta:55480, cluster:x.PAPEL, bancos:[a.banco]};
    assert.equal(x.conferirIdentidade(linha, a, a.banco, [a.banco]), true);
    assert.equal(x.conferirIdentidade({...linha, db:'postgres', bancos:[]}, a, 'postgres', []), true);
    for (const divergente of [{db:'kidmais_manager'}, {papel:'postgres'}, {endereco:'::1'}, {endereco:'10.0.0.5'}, {porta:5432}, {cluster:''}, {cluster:'kidmais_descartavel'},
        {bancos:[a.banco, 'kidmais_manager']}, {bancos:['kidmais_staging_1z91']}, {bancos:[]}])
        assert.equal(recusaDe(() => x.conferirIdentidade({...linha, ...divergente}, a, a.banco, [a.banco])), 'IDENTIDADE_DIVERGENTE', JSON.stringify(divergente));
    assert.equal(recusaDe(() => x.conferirIdentidade({...linha, db:'postgres', bancos:[a.banco]}, a, 'postgres', [])), 'IDENTIDADE_DIVERGENTE', 'banco já existe: não substituir');
    assert.equal(recusaDe(() => x.conferirIdentidade(undefined, a, a.banco, [a.banco])), 'IDENTIDADE_DIVERGENTE');
});

test('saída sanitizada: sem e-mail, UUID, token ou hash; tamanho limitado', () => {
    const t = x.sanitizar(`falha de pessoa@example.invalid em 3f0e4c2a-1b2c-4d3e-8f9a-0b1c2d3e4f5a token ${'A'.repeat(43)} hash ${'a'.repeat(64)} ${'x'.repeat(300)}`);
    assert.doesNotMatch(t, /@|3f0e4c2a|AAAAAAAAAA|aaaaaaaaaaaaaaaa/);
    assert.match(t, /<email>.*<uuid>.*<token>.*<hash>/);
    assert.ok(t.length <= 160);
});

test('plano offline: inventário e impressão do schema conferem com o pacote aprovado; nenhuma conexão', async () => {
    const p = await x.plano();
    assert.equal(p.ultima, '20261010_077_regras_pagamento_empresa.sql');
    assert.equal(p.impressao, x.IMPRESSAO_SCHEMA, 'migrations/checks mudaram: revisar o pacote e aprovar de novo');
    const r = rodar([]);
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.deepEqual([j.modo, j.conexao, j.confere], ['PLANO_OFFLINE', false, true]);
    assert.deepEqual(x.GRUPOS.map(g => g.id), ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'z']);
});

test('processo real: toda recusa ocorre antes do driver (sem flag, sem autorização, herdada, banco real, fora da raiz)', () => {
    let r = rodar(['--outra']);
    assert.equal(r.status, 1); assert.match(r.stderr, /^USO:/);
    r = rodar([x.FLAG]);
    assert.equal(r.status, 1); assert.match(r.stderr, /CONCORRENCIA_RECUSADA AUTORIZACAO_AUSENTE/);
    r = rodar([x.FLAG], {[x.VAR_AUTORIZACAO]:'127.0.0.1:5432/kidmais_manager'});
    assert.equal(r.status, 1); assert.match(r.stderr, /CONCORRENCIA_RECUSADA BANCO_PROIBIDO/);
    r = rodar([x.FLAG], {[x.VAR_AUTORIZACAO]:VALIDO, DATABASE_URL:'postgresql://u:s@localhost:5432/kidmais_manager'});
    assert.equal(r.status, 1); assert.match(r.stderr, /CONCORRENCIA_RECUSADA CONEXAO_HERDADA DATABASE_URL/);
    assert.doesNotMatch(r.stderr + r.stdout, /u:s@|kidmais_manager/, 'valor da variável herdada não é impresso');
    r = rodar([x.FLAG], {[x.VAR_AUTORIZACAO]:VALIDO}, __dirname);
    assert.equal(r.status, 1); assert.match(r.stderr, /CONCORRENCIA_RECUSADA EXECUTAR_NA_RAIZ_DO_REPOSITORIO/);
});

test('coerência com o cluster descartável: papel, cluster_name, porta e padrão do banco batem com a lista fechada', () => {
    const cluster = require('./cluster-descartavel-postgres.cjs');
    assert.equal(cluster.CLUSTERS[x.PAPEL]?.porta, x.PORTA_SUGERIDA);
    assert.equal(cluster.validarBanco(x.BANCO_SUGERIDO, x.PAPEL), x.BANCO_SUGERIDO);
    assert.equal(x.alvo(env(VALIDO)).porta, cluster.CLUSTERS.kidmais_concorrencia.porta);
});

test('fonte: nunca apaga banco/linhas, não desliga gatilhos, não lê .env e bloqueia rede', () => {
    for (const proibido of [/DROP\s+DATABASE/i, /DISABLE\s+TRIGGER/i, /\bDELETE\s+FROM\b/i, /\bTRUNCATE\b/i, /--env-file/, /['"`][^'"`\n]*\.env/, /dotenv/, /onrender\.com|asaas\.com/i])
        assert.doesNotMatch(fonte, proibido, String(proibido));
    assert.equal(fonte.match(/CREATE DATABASE/g).length, 1);
    assert.match(fonte, /global\.fetch = async \(\) => \{ throw Error\('REDE_PROIBIDA'\); \}/);
    assert.match(fonte, /enviarEmail:async \(\) => \{ throw Error\('ENVIO_PROIBIDO'\); \}/);
    assert.match(fonte, /password:async \(\) => \{ throw recusa\('SERVIDOR_PEDIU_SENHA'\); \}/);
    // Ordem das guardas em executar(): alvo → herdadas → raiz → impressão, tudo antes de construirSchema/conectar.
    const corpo = fonte.slice(fonte.indexOf('async function executar('));
    const ordem = ['alvo(env)', 'semConexaoHerdada(env)', 'EXECUTAR_NA_RAIZ_DO_REPOSITORIO', 'SCHEMA_DIVERGENTE_DO_PACOTE', 'construirSchema(a, p)'].map(t => corpo.indexOf(t));
    assert.ok(ordem.every(i => i >= 0) && ordem.every((i, k) => k === 0 || i > ordem[k - 1]), JSON.stringify(ordem));
});
