'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const database = require('./check-database-target.cjs');
const envCheck = require('./check-env.cjs');
const migrations = require('./check-migrations.cjs');
const smoke = require('./smoke-test.cjs');
const { aggregate, gates } = require('./go-no-go.cjs');
function fixture() {
  return { NODE_ENV: 'production', NODE_VERSION: '22.23.2', KIDMAIS_DEPLOY_ENV: 'production', DATABASE_URL: 'postgresql://synthetic:FAKE_PASSWORD@database.example/kidmais_production', DATABASE_POOL_MAX: '10', DATABASE_CONNECTION_TIMEOUT_MS: '5000', DATABASE_IDLE_TIMEOUT_MS: '30000', DATABASE_SSL: 'true', DATABASE_SSL_REJECT_UNAUTHORIZED: 'true', FESTA_ENABLED: 'true', CONTRATO_ACEITE_DEV_ENABLED: 'false', ADMIN_AUTH_ORIGIN: 'https://admin.example', ADMIN_AUTH_SECRET: 'SYNTHETIC_ADMIN_VALUE_'.repeat(3), IDENTIDADE_OTP_PEPPER: 'SYNTHETIC_PEPPER_VALUE', WHATSAPP_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'), WHATSAPP_CREDENTIAL_KEY_VERSION: '1', META_APP_SECRET: 'SYNTHETIC_META_SECRET', WHATSAPP_CLOUD_ACCESS_TOKEN: 'SYNTHETIC_TOKEN' };
}
function run(file, env, args = ['--json']) {
  return spawnSync(process.execPath, [path.join(__dirname, file + '.cjs'), ...args], { encoding: 'utf8', env: { ...env, SystemRoot: process.env.SystemRoot, PATH: process.env.PATH } });
}
const ready = { ok: true, status: 'ready', components: { database: 'ready', festa: 'ready', otp: 'ready' } };
for (const suffix of ['db.example/kidmais_staging', 'db.example/kidmais-staging', 'db.example/kidmais_manager', 'localhost/kidmais_production', '127.0.0.1/kidmais_production', '127.2.3.4/kidmais_production', '[::1]/kidmais_production', 'localhost./kidmais_production']) {
  test('production refuses ' + suffix, async () => {
    const env = { ...fixture(), DATABASE_URL: 'postgresql://synthetic:FAKE_PASSWORD@' + suffix };
    assert.ok((await database.check(env, { connect: true })).blockers.length);
    assert.equal(run('check-database-target', env).status, 1);
  });
}
test('staging refuses production and protected local database', () => {
  for (const name of ['kidmais_production', 'kidmais-production', 'kidmais_manager']) assert.ok(database.target({ ...fixture(), KIDMAIS_DEPLOY_ENV: 'staging', DATABASE_URL: 'postgres://synthetic:FAKE@db.example/' + name }).blockers.length);
});
test('malformed URLs and connection overrides fail safely', () => {
  for (const value of ['FAKE_TOKEN', 'http://user:pass@db.example/db', 'postgres://user:pass@db.example/%ZZ', fixture().DATABASE_URL + '?host=localhost', fixture().DATABASE_URL + '#FAKE_TOKEN']) {
    const r = run('check-database-target', { ...fixture(), DATABASE_URL: value });
    assert.equal(r.status, 1); assert.equal(JSON.parse(r.stdout).ok, false); assert.ok(!r.stdout.includes(value));
  }
});
test('required environment and production policies', () => {
  assert.deepEqual(envCheck.check(fixture()).blockers, []);
  for (const key of Object.keys(fixture()).filter(x => !['META_APP_SECRET', 'WHATSAPP_CLOUD_ACCESS_TOKEN'].includes(x))) {
    const env = fixture(); delete env[key]; assert.ok(envCheck.check(env).blockers.length, key);
  }
  for (const change of [{ KIDMAIS_STAGING_OTP_DISABLED: 'SIM' }, { DATABASE_SSL: 'false' }, { FESTA_ENABLED: 'false' }, { CONTRATO_ACEITE_DEV_ENABLED: 'true' }, { WHATSAPP_CREDENTIAL_ENCRYPTION_KEY: 'invalid' }]) assert.ok(envCheck.check({ ...fixture(), ...change }).blockers.length);
});
test('all CLI JSON and text outputs exclude synthetic secrets', () => {
  const env = fixture();
  for (const file of ['check-env', 'check-database-target', 'check-migrations', 'smoke-test', 'go-no-go']) {
    for (const args of [[], ['--json']]) {
      const r = run(file, env, args);
      assert.equal(r.stderr, '');
      if (args.length) assert.equal(JSON.parse(r.stdout).schemaVersion, 1);
      for (const key of ['DATABASE_URL', 'ADMIN_AUTH_SECRET', 'IDENTIDADE_OTP_PEPPER', 'WHATSAPP_CREDENTIAL_ENCRYPTION_KEY', 'META_APP_SECRET', 'WHATSAPP_CLOUD_ACCESS_TOKEN']) assert.ok(!r.stdout.includes(env[key]), file + ':' + key);
      assert.ok(!r.stdout.includes('FAKE_PASSWORD'));
    }
  }
});
test('unknown/duplicate arguments fail with JSON and no echoed argument', () => {
  for (const args of [['--json', '--token=SYNTHETIC_TOKEN'], ['--json', '--json'], ['--json', '--connect=false']]) {
    const r = run('check-database-target', fixture(), args); assert.equal(r.status, 1); assert.equal(JSON.parse(r.stdout).ok, false); assert.ok(!r.stdout.includes('SYNTHETIC_TOKEN'));
  }
});
test('staging degraded requires explicit disabled OTP', () => {
  const env = { ...fixture(), KIDMAIS_DEPLOY_ENV: 'staging', IDENTIDADE_OTP_PROVIDER: 'disabled', KIDMAIS_STAGING_OTP_DISABLED: 'SIM', DATABASE_URL: 'postgres://synthetic:FAKE@db.example/kidmais_staging' };
  const body = { ...ready, status: 'degraded', components: { ...ready.components, otp: 'unavailable' } };
  assert.deepEqual(envCheck.check(env).blockers, []);
  assert.deepEqual(smoke.evaluate(env, 200, body).blockers, []);
  delete env.KIDMAIS_STAGING_OTP_DISABLED;
  assert.ok(smoke.evaluate(env, 200, body).blockers.length);
});
test('database/festa failures and actual 503 block', () => {
  for (const name of ['database', 'festa']) assert.ok(smoke.evaluate(fixture(), 200, { ...ready, components: { ...ready.components, [name]: 'unavailable' } }).blockers.length);
  assert.ok(smoke.evaluate(fixture(), 503, { ok: false, status: 'unavailable' }).blockers.includes('HEALTH_HTTP_NOT_200'));
});
test('smoke mocked transport: GET, redirect refusal, invalid JSON, oversized body', async () => {
  const opts = { 'base-url': 'https://admin.example' };
  const r = await smoke.check(fixture(), opts, async (url, options) => { assert.equal(url.pathname, '/api/health'); assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error'); return new Response(JSON.stringify(ready)); });
  assert.deepEqual(r.blockers, []);
  for (const content of ['SYNTHETIC_TOKEN', 'x'.repeat(65537)]) assert.ok((await smoke.check(fixture(), opts, async () => new Response(content))).blockers.length);
  for (const url of ['http://admin.example', 'https://user:FAKE@admin.example', 'https://admin.example/?token=FAKE']) assert.ok((await smoke.check(fixture(), { 'base-url': url }, () => { throw new Error('must not fetch'); })).blockers.length);
});
test('inventory excludes rollback and never claims applied state', async () => {
  const r = await migrations.check({}); assert.deepEqual(r.blockers, []); assert.equal(r.evidence[0].appliedState, 'unknown'); assert.ok(r.evidence[0].latest.includes('_018_')); assert.ok(!r.evidence[0].migrations.some(x => x.includes('999')));
});
test('aggregator fails closed, distinguishes partial/commercial and stale reports', () => {
  const binding = { environment: 'production', commit: 'synthetic-commit', origin: 'https://admin.example', database: 'kidmais_production' };
  const record = { ...binding, schemaVersion: 1, verifiedAt: new Date().toISOString(), ...Object.fromEntries(gates.map(x => [x, true])) };
  const results = [smoke.evaluate(fixture(), 200, ready)];
  assert.equal(aggregate(results, undefined, binding).decision, 'NO-GO');
  assert.equal(aggregate(results, record, binding).decision, 'GO-PARCIAL');
  assert.equal(aggregate(results, { ...record, whatsappDelivery: true }, binding).decision, 'GO');
  for (const change of [{ environment: 'staging' }, { migrationsThrough018: false }, { credentialRotation: false }, { verifiedAt: '2000-01-01T00:00:00Z' }, { commit: 'wrong' }]) assert.equal(aggregate(results, { ...record, ...change }, binding).decision, 'NO-GO');
});
test('optional connection uses read-only session and fixed SELECTs through fake pg', async () => {
  const Module = require('node:module');
  const original = Module._load;
  const queries = []; let ended = false;
  class FakeClient {
    constructor(config) { assert.ok(config.options.includes('default_transaction_read_only=on')); assert.equal(config.ssl.rejectUnauthorized, true); }
    on() {}
    async connect() {}
    async query(sql) { queries.push(sql); return { rows: sql.includes('current_database()') ? [{ database: 'kidmais_production' }] : [{ count: 63 }] }; }
    async end() { ended = true; }
  }
  Module._load = function(name, ...args) { return name === 'pg' ? { Client: FakeClient } : original.call(this, name, ...args); };
  try {
    assert.deepEqual((await database.check(fixture(), { connect: true })).blockers, []);
    assert.equal(queries.length, 2); assert.ok(queries.every(x => x.startsWith('SELECT '))); assert.equal(ended, true);
  } finally { Module._load = original; }
});
