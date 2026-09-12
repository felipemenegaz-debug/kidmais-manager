/* eslint-disable @typescript-eslint/no-require-imports -- Guarda executada por runners CommonJS. */
const assert = require('node:assert/strict');

const DATABASE_NAME = 'kidmais_v1_homologacao';
const OPT_IN_NAME = 'KIDMAIS_REGRESSAO_HOMOLOGACAO';
const URL_NAME = 'KIDMAIS_HOMOLOGACAO_DATABASE_URL';

function parseTarget(env = process.env) {
  assert.equal(
    env[OPT_IN_NAME],
    'SIM',
    `Regressão recusada: defina ${OPT_IN_NAME}=SIM explicitamente.`,
  );
  assert.ok(
    env[URL_NAME],
    `Regressão recusada: ${URL_NAME} não configurada. DATABASE_URL e .env.local não são aceitos como origem.`,
  );

  let url;
  try {
    url = new URL(env[URL_NAME]);
  } catch {
    throw new Error(`Regressão recusada: ${URL_NAME} inválida.`);
  }

  assert.ok(
    ['postgres:', 'postgresql:'].includes(url.protocol),
    'Regressão recusada: a conexão deve usar PostgreSQL.',
  );
  assert.equal(
    decodeURIComponent(url.pathname.slice(1)),
    DATABASE_NAME,
    `Regressão recusada: o banco deve se chamar exatamente ${DATABASE_NAME}.`,
  );

  const host = url.hostname.toLowerCase();
  assert.ok(
    host === 'localhost' || host === '::1' || host === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(host),
    'Regressão recusada: o PostgreSQL deve estar no host local.',
  );

  return url;
}

function assertRuntimeDatabaseName(name) {
  assert.equal(
    name,
    DATABASE_NAME,
    `Conexão recusada: o servidor respondeu com banco diferente de ${DATABASE_NAME}.`,
  );
}

module.exports = { DATABASE_NAME, OPT_IN_NAME, URL_NAME, parseTarget, assertRuntimeDatabaseName };
