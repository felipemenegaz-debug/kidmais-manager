/* eslint-disable @typescript-eslint/no-require-imports */
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseTarget, assertRuntimeDatabaseName } = require('./regressao-v1-clone-guard.cjs');

const safe = {
  KIDMAIS_REGRESSAO_HOMOLOGACAO: 'SIM',
  KIDMAIS_HOMOLOGACAO_DATABASE_URL:
    'postgresql://teste:segredo@127.0.0.1:5432/kidmais_v1_homologacao',
};

test('aceita somente opt-in, host local e nome exato do clone sanitizado', () => {
  assert.equal(parseTarget(safe).pathname, '/kidmais_v1_homologacao');
  assert.equal(parseTarget({
    ...safe,
    KIDMAIS_HOMOLOGACAO_DATABASE_URL: 'postgresql://teste:segredo@[::1]/kidmais_v1_homologacao',
  }).hostname, '[::1]');
  assertRuntimeDatabaseName('kidmais_v1_homologacao');
});

for (const [nome, env] of [
  ['sem opt-in', { ...safe, KIDMAIS_REGRESSAO_HOMOLOGACAO: 'NAO' }],
  ['sem URL dedicada', { KIDMAIS_REGRESSAO_HOMOLOGACAO: 'SIM' }],
  ['banco real', { ...safe, KIDMAIS_HOMOLOGACAO_DATABASE_URL: 'postgresql://u:s@127.0.0.1/kidmais_manager' }],
  ['outro clone', { ...safe, KIDMAIS_HOMOLOGACAO_DATABASE_URL: 'postgresql://u:s@127.0.0.1/kidmais_016_1' }],
  ['host remoto', { ...safe, KIDMAIS_HOMOLOGACAO_DATABASE_URL: 'postgresql://u:s@db.example/kidmais_v1_homologacao' }],
]) {
  test(`recusa ${nome} antes de qualquer conexão`, () => assert.throws(() => parseTarget(env)));
}

test('recusa divergência informada pelo servidor', () => {
  assert.throws(() => assertRuntimeDatabaseName('kidmais_manager'));
});
