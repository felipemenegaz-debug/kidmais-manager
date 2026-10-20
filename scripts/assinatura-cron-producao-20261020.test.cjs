/* eslint-disable @typescript-eslint/no-require-imports */
// Cron de conferência de pagamentos de PRODUÇÃO (docs/CRON_ASSINATURA_PRODUCAO_20261020.md): a definição revisável
// (infra/render-assinatura-cron-production.yaml) e o comportamento do código JÁ publicado em production (dc157a7) com ela.
// Sem banco e sem rede: os processos reais recusam ANTES de conectar ou de chamar o Asaas.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {planejar} = require('./assinatura-cron.cjs');
const {validarAlvo, opcoesConexao, codigoDeSaida, executarCiclo, PRODUCAO} = require('./assinatura-reconciliar.cjs');

const raiz = path.resolve(__dirname, '..');
const texto = fs.readFileSync(path.join(raiz, 'infra/render-assinatura-cron-production.yaml'), 'utf8');
/**
 * Leitura SEM dependência (P3-B5 da revisão: js-yaml só existe como dependência transitiva do ESLint) do formato fixo dos
 * dois YAML de cron: um serviço, campos escalares com 4 espaços e envVars como "- key:" seguido de "value:" ou "sync:".
 * Qualquer linha fora desse formato falha o teste (o arquivo precisa continuar simples e revisável).
 */
function lerCron(conteudo) {
  const escalar = v => { const t = v.replace(/\s+#.*$/, '').trim(); return /^"(.*)"$/.test(t) ? t.slice(1, -1) : t === 'false' ? false : t; };
  const s = {envVars: []};
  let emEnv = false;
  for (const linha of conteudo.split(/\r?\n/)) {
    if (!linha.trim() || /^\s*#/.test(linha) || linha === 'services:') continue;
    let m;
    if ((m = /^ {2}- type: (.+)$/.exec(linha))) { s.type = escalar(m[1]); continue; }
    if (linha === '    envVars:') { emEnv = true; continue; }
    if (emEnv && (m = /^ {6}- key: (.+)$/.exec(linha))) { s.envVars.push({key: escalar(m[1])}); continue; }
    if (emEnv && (m = /^ {8}(value|sync): (.+)$/.exec(linha))) { s.envVars.at(-1)[m[1]] = escalar(m[2]); continue; }
    if (!emEnv && (m = /^ {4}(\w+): (.+)$/.exec(linha))) { s[m[1]] = escalar(m[2]); continue; }
    throw new Error('LINHA_FORA_DO_FORMATO ' + linha);
  }
  return s;
}
const servico = lerCron(texto);
const staging = lerCron(fs.readFileSync(path.join(raiz, 'infra/render-assinatura-cron.yaml'), 'utf8'));
const fixos = Object.fromEntries(servico.envVars.filter(v => Object.hasOwn(v, 'value')).map(v => [v.key, String(v.value)]));
const secretos = servico.envVars.filter(v => v.sync === false).map(v => v.key);
// Valores FICTÍCIOS só no formato (nunca credenciais): URL interna sem senha real, chave com o prefixo de produção.
const URL_FICTICIA = `postgresql://ficticio@${PRODUCAO.host}/${PRODUCAO.database}`;
const ASAAS_FICTICIO = {ASAAS_API_KEY: '$aact_prod_' + 'x'.repeat(40), ASAAS_WEBHOOK_TOKEN: 'y'.repeat(40)};
/** Ambiente do cron como o Render o montaria (RENDER e RENDER_SERVICE_ID são do próprio Render). */
const envCron = (extra = {}) => ({PATH: process.env.PATH, RENDER: 'true', RENDER_SERVICE_ID: 'crn-ficticio-producao', ...fixos, KIDMAIS_RECONCILIAR_DATABASE_URL: URL_FICTICIA, ...extra});
const rodarCron = env => spawnSync(process.execPath, [path.join(__dirname, 'assinatura-cron.cjs')], {cwd: raiz, encoding: 'utf8', env, timeout: 60000});

test('definição: serviço, branch production, diário, mesmos build/start/plano/região do cron de staging, variáveis exatas', () => {
  assert.equal(servico.type, 'cron'); assert.equal(servico.name, 'kidmais-assinatura-reconciliar-production');
  assert.equal(servico.branch, 'production'); assert.equal(servico.autoDeployTrigger, 'off'); assert.equal(servico.schedule, '0 9 * * *');
  for (const k of ['runtime', 'plan', 'region', 'repo', 'buildCommand', 'startCommand']) assert.equal(servico[k], staging[k], k);
  assert.deepEqual(fixos, {NODE_VERSION: '22.23.2', NODE_ENV: 'production', KIDMAIS_DEPLOY_ENV: 'production', KIDMAIS_RECONCILIAR_MODO: 'aguardando',
    KIDMAIS_RECONCILIAR_SCHEMA_VALIDADO: '074-075', KIDMAIS_RECONCILIAR_ALVO: 'kidmais_production@dpg-dak750gae00c73fudmg0-a:5432', ASAAS_AMBIENTE: 'producao',
    DATABASE_SSL: 'true', DATABASE_SSL_REJECT_UNAUTHORIZED: 'false'});
  assert.deepEqual(secretos, ['KIDMAIS_RECONCILIAR_DATABASE_URL', 'ASAAS_API_KEY', 'ASAAS_WEBHOOK_TOKEN']);
  assert.equal(staging.name, 'kidmais-assinatura-reconciliar-staging'); assert.equal(staging.envVars.length, 10, 'leitor sem dependência lê o YAML de staging inteiro');
  const chaves = servico.envVars.map(v => v.key);
  for (const proibida of ['DATABASE_URL', 'KIDMAIS_RECONCILIAR_TLS', 'KIDMAIS_RECONCILIAR_CA_PEM']) assert.ok(!chaves.includes(proibida), proibida);
  assert.doesNotMatch(texto, /\$aact_|postgres(?:ql)?:\/\/|sk_|re_[A-Za-z0-9]{8}/, 'nenhum segredo no arquivo');
  for (const arquivo of ['scripts/assinatura-cron.cjs', 'scripts/assinatura-cron.test.cjs', 'scripts/assinatura-reconciliar.test.cjs'])
    assert.ok(fs.existsSync(path.join(raiz, arquivo)), arquivo);
});

test('aguardando = no-op seguro: sai 0 sem conectar, mesmo sem URL do banco nem Asaas', () => {
  assert.equal(planejar(envCron()), null);
  const semNada = {PATH: process.env.PATH, RENDER: 'true', KIDMAIS_DEPLOY_ENV: 'production', KIDMAIS_RECONCILIAR_MODO: 'aguardando'};
  for (const env of [envCron(), semNada]) {
    const p = rodarCron(env);
    assert.equal(p.status, 0, p.stderr); assert.deepEqual(JSON.parse(p.stdout), {estado: 'AGUARDANDO_HABILITACAO', conectou: false});
  }
});

test('conferir SEM Asaas de produção configurado: recusa (código 1) ANTES de conectar e de chamar o provedor — não é no-op', () => {
  const casos = [
    [{}, /ASAAS_API_KEY não definida: cobrança desligada/],
    [{ASAAS_API_KEY: '$aact_hmlg_' + 'x'.repeat(40), ASAAS_WEBHOOK_TOKEN: 'y'.repeat(40)}, /não é uma chave de produção/],
    [{ASAAS_API_KEY: ASAAS_FICTICIO.ASAAS_API_KEY}, /ASAAS_WEBHOOK_TOKEN ausente/],
  ];
  for (const [extra, msg] of casos) {
    const p = rodarCron(envCron({KIDMAIS_RECONCILIAR_MODO: 'conferir', ...extra}));
    assert.equal(p.status, 1, p.stdout + p.stderr); assert.match(p.stderr, msg);
    assert.doesNotMatch(p.stdout + p.stderr, /ENOTFOUND|ECONNREFUSED|getaddrinfo|timeout|connect/i, 'nenhuma tentativa de conexão');
  }
  // Sem ASAAS_AMBIENTE=producao, o alvo de produção nem é aceito (recusa já no plano do cron).
  const p = rodarCron(envCron({KIDMAIS_RECONCILIAR_MODO: 'conferir', ASAAS_AMBIENTE: undefined, ...ASAAS_FICTICIO}));
  assert.equal(p.status, 1); assert.match(p.stderr, /Cron recusado/);
});

test('travas: nunca aplica em produção, nunca alvo de staging/sandbox, nunca DATABASE_URL igual, TLS do serviço', () => {
  const env = envCron({KIDMAIS_RECONCILIAR_MODO: 'conferir', ...ASAAS_FICTICIO});
  assert.deepEqual(planejar(env), [], 'conferir = simulação, sem --aplicar');
  const recusas = [
    {KIDMAIS_RECONCILIAR_MODO: 'aplicar'}, {KIDMAIS_RECONCILIAR_MODO: 'simular'}, {KIDMAIS_RECONCILIAR_SCHEMA_VALIDADO: undefined},
    {KIDMAIS_DEPLOY_ENV: undefined}, {RENDER: undefined}, {ASAAS_AMBIENTE: 'sandbox'},
    {KIDMAIS_RECONCILIAR_DATABASE_URL: 'postgresql://ficticio@dpg-daidko3m8hqs73ce4jt0-a/kidmais_staging_1z91', KIDMAIS_RECONCILIAR_ALVO: 'kidmais_staging_1z91@dpg-daidko3m8hqs73ce4jt0-a:5432'},
    {KIDMAIS_RECONCILIAR_DATABASE_URL: `postgresql://ficticio@${PRODUCAO.host}.virginia-postgres.render.com/${PRODUCAO.database}`},
    {DATABASE_URL: URL_FICTICIA}, {KIDMAIS_RECONCILIAR_ALVO: 'kidmais_production@dpg-dak750gae00c73fudmg0-a:5433'},
  ];
  for (const r of recusas) assert.throws(() => planejar({...env, ...r}), undefined, JSON.stringify(r));
  // Cron de STAGING apontado para produção: recusado (produção nunca é alvo do modo simular/aplicar).
  assert.throws(() => planejar({...env, KIDMAIS_DEPLOY_ENV: 'staging', KIDMAIS_RECONCILIAR_MODO: 'aplicar', ASAAS_AMBIENTE: 'sandbox'}));
  const alvo = validarAlvo(env);
  assert.equal(alvo.producao, true); assert.equal(alvo.port, 5432);
  assert.deepEqual(opcoesConexao(alvo, env).ssl, {rejectUnauthorized: false, minVersion: 'TLSv1.2'});
  assert.equal(opcoesConexao(alvo, {...env, DATABASE_SSL_REJECT_UNAUTHORIZED: undefined}).ssl.rejectUnauthorized, true);
  assert.throws(() => opcoesConexao(alvo, {...env, DATABASE_SSL: undefined}), /TLS_PRODUCAO_RECUSADO/);
  assert.throws(() => opcoesConexao(alvo, {...env, KIDMAIS_RECONCILIAR_TLS: 'render-interno-criptografado'}), /TLS_PRODUCAO_RECUSADO/);
});

test('conferir com Asaas configurado e nenhuma assinatura: nenhuma chamada ao provedor, código 0; divergência ou Kidmais violada = 2', async () => {
  const chamadas = [];
  const provedor = new Proxy({}, {get: (_t, k) => async () => { chamadas.push(String(k)); throw new Error('não deveria chamar'); }});
  const sinc = {eventosPendentes: async () => [], empresasComProvedor: async () => []};
  const comandos = [];
  const r = await executarCiclo({client: {query: async s => comandos.push(s)}, provedor, aplicar: false, banco: PRODUCAO.database, sinc});
  r.kidmais = {violada: false};
  assert.deepEqual(chamadas, []); assert.deepEqual(comandos, []);
  assert.equal(r.divergente, false); assert.equal(r.incompleto, false); assert.equal(codigoDeSaida(r, true), 0);
  assert.equal(codigoDeSaida({...r, kidmais: {violada: true}}, true), 2);
  assert.equal(codigoDeSaida({...r, divergente: true}, true), 2);
  assert.equal(codigoDeSaida({...r, incompleto: true}, true), 2);
});
