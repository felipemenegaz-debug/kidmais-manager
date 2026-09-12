/* eslint-disable @typescript-eslint/no-require-imports -- Runner Node CommonJS. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const FLAG_STAGING = 'SIM';
const NOME_PRODUCAO = 'kidmais_manager';
const PEPPER_OTP_STAGING = 'kidmais-staging-v1-otp-pepper-sintetico-nao-producao';
const CHAVE_LOCK = 'kidmais-regressao-v1-staging';
const PADRAO_BANCO_STAGING = /^kidmais_staging(?:_[a-z0-9]+)*$/;
const carregarTypeScript = (arquivo) => [
  process.execPath,
  '-r',
  './scripts/pagamentos-test-support.cjs',
  '-e',
  `require('${arquivo}')`,
];

const todasSuites = [
  ['identidade-repository', carregarTypeScript('./scripts/identidade-repository.integration.ts')],
  ['identidade-service', carregarTypeScript('./scripts/identidade-service.integration.ts')],
  ['identidade-fechamento', carregarTypeScript('./scripts/identidade-fechamento.integration.ts')],
  ['jornada-fechamento-contrato-otp-pagamento', [process.execPath, './scripts/condicao-pagamento.integration.cjs']],
  ['pagamentos-engenharia', [process.execPath, './scripts/pagamentos-engenharia.integration.cjs']],
  ['pagamentos-http', [process.execPath, './scripts/pagamentos-http.integration.cjs']],
  ['festa-vigencia-remarcacao', [process.execPath, './scripts/festa-016-vigencia.cjs']],
];
const arquivosSuites = new Map([
  ['identidade-repository', './scripts/identidade-repository.integration.ts'],
  ['identidade-service', './scripts/identidade-service.integration.ts'],
  ['identidade-fechamento', './scripts/identidade-fechamento.integration.ts'],
  ['jornada-fechamento-contrato-otp-pagamento', './scripts/condicao-pagamento.integration.cjs'],
  ['pagamentos-engenharia', './scripts/pagamentos-engenharia.integration.cjs'],
  ['pagamentos-http', './scripts/pagamentos-http.integration.cjs'],
  ['festa-vigencia-remarcacao', './scripts/festa-016-vigencia.cjs'],
]);

function exigirTexto(env, nome) {
  const valor = env[nome]?.trim();
  if (!valor) throw new Error(`${nome} é obrigatória.`);
  return valor;
}

function nomeDoBanco(url) {
  const partes = url.pathname.split('/').filter(Boolean);
  if (partes.length !== 1) throw new Error('URL de staging deve identificar exatamente um banco.');
  return decodeURIComponent(partes[0]);
}

function ehLoopback(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

function assinaturaSemCredenciais(url) {
  return `${url.protocol}//${url.hostname.toLowerCase()}:${url.port || '5432'}/${nomeDoBanco(url)}`;
}

function validarConfiguracao(env = process.env) {
  if (env.KIDMAIS_REGRESSAO_STAGING !== FLAG_STAGING) {
    throw new Error('Execução recusada: KIDMAIS_REGRESSAO_STAGING deve ser SIM.');
  }
  const databaseUrl = exigirTexto(env, 'KIDMAIS_STAGING_DATABASE_URL');
  const databaseName = exigirTexto(env, 'KIDMAIS_STAGING_DATABASE_NAME');
  const databaseHost = exigirTexto(env, 'KIDMAIS_STAGING_DATABASE_HOST').toLowerCase();
  let url;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error('KIDMAIS_STAGING_DATABASE_URL inválida.');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error('A URL de staging deve usar PostgreSQL.');
  }
  if (!url.username || !url.password) {
    throw new Error('A URL de staging deve conter credenciais próprias de staging.');
  }
  const nomeReal = nomeDoBanco(url);
  if (nomeReal === NOME_PRODUCAO || /(?:^|_)(?:prod|producao|production)(?:_|$)/i.test(nomeReal)) {
    throw new Error('Execução recusada: banco de produção não é permitido.');
  }
  if (!PADRAO_BANCO_STAGING.test(databaseName) || nomeReal !== databaseName) {
    throw new Error('O banco deve corresponder ao nome exato de staging configurado.');
  }
  if (ehLoopback(url.hostname)) {
    throw new Error('Modo staging cloud recusa localhost e endereços de loopback.');
  }
  if (url.hostname.toLowerCase() !== databaseHost || ehLoopback(databaseHost)) {
    throw new Error('O host deve corresponder ao host remoto de staging configurado.');
  }
  const sslmode = url.searchParams.get('sslmode')?.toLowerCase();
  if (!['require', 'verify-ca', 'verify-full'].includes(sslmode)) {
    throw new Error('TLS é obrigatório: use sslmode=require, verify-ca ou verify-full.');
  }
  const producao = env.KIDMAIS_PRODUCTION_DATABASE_URL?.trim();
  if (producao) {
    let urlProducao;
    try {
      urlProducao = new URL(producao);
    } catch {
      throw new Error('KIDMAIS_PRODUCTION_DATABASE_URL inválida; comparação segura impossível.');
    }
    if (assinaturaSemCredenciais(url) === assinaturaSemCredenciais(urlProducao)) {
      throw new Error('Execução recusada: a URL de staging aponta para o destino de produção.');
    }
  }
  return { databaseUrl, databaseName, databaseHost };
}

function selecionarSuites(solicitadas = []) {
  const nomes = todasSuites.map(([nome]) => nome);
  for (const nome of solicitadas) {
    if (!nomes.includes(nome)) throw new Error(`Suíte inexistente: ${nome}`);
  }
  const selecao = solicitadas.length > 0 ? solicitadas : nomes;
  return selecao.map((nome) => todasSuites.find(([candidato]) => candidato === nome));
}

function construirAmbienteFilho(env, configuracao) {
  const filho = {
    ...env,
    DATABASE_URL: configuracao.databaseUrl,
    DATABASE_SSL: 'true',
    DATABASE_SSL_REJECT_UNAUTHORIZED: 'true',
    KIDMAIS_REGRESSAO_STAGING: FLAG_STAGING,
    KIDMAIS_STAGING_DATABASE_URL: configuracao.databaseUrl,
    KIDMAIS_STAGING_DATABASE_NAME: configuracao.databaseName,
    KIDMAIS_STAGING_DATABASE_HOST: configuracao.databaseHost,
    IDENTIDADE_OTP_PEPPER: PEPPER_OTP_STAGING,
    FESTA_ENABLED: 'true',
  };
  delete filho.KIDMAIS_REGRESSAO_HOMOLOGACAO;
  delete filho.KIDMAIS_HOMOLOGACAO_DATABASE_URL;
  delete filho.KIDMAIS_PRODUCTION_DATABASE_URL;
  return filho;
}

function executarSuite(nome, comando, envFilho) {
  const temporarios = path.join(process.cwd(), '.tmp');
  fs.mkdirSync(temporarios, { recursive: true });
  const log = path.join(temporarios, `regressao-v1-staging-${nome}.log`);
  const [executavel, ...argumentos] = comando;
  const resultado = spawnSync(executavel, argumentos, {
    cwd: process.cwd(), env: envFilho, encoding: 'utf8', timeout: 240_000, maxBuffer: 20 * 1024 * 1024,
  });
  fs.writeFileSync(log, `${resultado.stdout || ''}${resultado.stderr || ''}`, 'utf8');
  if (resultado.stdout) process.stdout.write(resultado.stdout);
  if (resultado.stderr) process.stderr.write(resultado.stderr);
  if (resultado.error) throw resultado.error;
  if (resultado.status !== 0) throw new Error(`Suíte ${nome} falhou com exit code ${resultado.status}. Log: ${log}`);
  console.log(`PASS ${nome}`);
}

function citarIdentificador(valor) {
  return `"${valor.replaceAll('"', '""')}"`;
}

async function fotografarBanco(client) {
  const tabelas = await client.query(`SELECT n.nspname AS schema_name, c.relname AS table_name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='r' AND n.nspname='public' ORDER BY n.nspname,c.relname`);
  const fotografia = {};
  for (const tabela of tabelas.rows) {
    const chave = `${tabela.schema_name}.${tabela.table_name}`;
    const conteudo = await client.query(`SELECT COUNT(*)::bigint AS total, md5(COALESCE(string_agg(linha, E'\\n' ORDER BY linha), '')) AS hash FROM (SELECT to_jsonb(t)::text AS linha FROM ${citarIdentificador(tabela.schema_name)}.${citarIdentificador(tabela.table_name)} t) dados`);
    fotografia[chave] = conteudo.rows[0];
  }
  return fotografia;
}

async function executar() {
  const { Client } = require('pg');
  const configuracao = validarConfiguracao(process.env);
  const suites = selecionarSuites(process.argv.slice(2));
  for (const [nome] of suites) {
    const arquivo = arquivosSuites.get(nome);
    if (!arquivo || !fs.existsSync(arquivo)) throw new Error(`Arquivo da suíte não encontrado: ${nome}.`);
  }
  const envFilho = construirAmbienteFilho(process.env, configuracao);
  const client = new Client({ connectionString: configuracao.databaseUrl, ssl: { rejectUnauthorized: true }, application_name: 'kidmais-regressao-v1-staging' });
  let lockObtido = false;
  let fotografiaInicial;
  let erroPrincipal;
  await client.connect();
  try {
    const destino = await client.query(`SELECT current_database() AS banco, COALESCE((SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()),false) AS tls`);
    assert.equal(destino.rows[0].banco, configuracao.databaseName, 'Banco conectado diverge do staging configurado.');
    assert.equal(destino.rows[0].tls, true, 'A conexão física com staging não usa TLS.');
    const lock = await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS obtido', [CHAVE_LOCK]);
    if (!lock.rows[0].obtido) throw new Error('Outra regressão de staging já está em execução.');
    lockObtido = true;
    fotografiaInicial = await fotografarBanco(client);
    for (const [nome, comando] of suites) executarSuite(nome, comando, envFilho);
  } catch (erro) {
    erroPrincipal = erro;
  } finally {
    try {
      if (fotografiaInicial) {
        assert.deepEqual(await fotografarBanco(client), fotografiaInicial, 'Postflight recusado: estrutura ou contagens de linhas mudaram durante a regressão.');
        console.log('PASS postflight: staging preservado após as suítes.');
      }
    } catch (erroPostflight) {
      erroPrincipal = erroPrincipal ? new AggregateError([erroPrincipal, erroPostflight], 'Falha de suíte e falha no postflight.') : erroPostflight;
    }
    if (lockObtido) await client.query('SELECT pg_advisory_unlock(hashtext($1))', [CHAVE_LOCK]);
    await client.end();
  }
  if (erroPrincipal) throw erroPrincipal;
}

module.exports = { PEPPER_OTP_STAGING, construirAmbienteFilho, selecionarSuites, todasSuites, validarConfiguracao };
if (require.main === module) executar().catch((erro) => { console.error(erro); process.exitCode = 1; });
