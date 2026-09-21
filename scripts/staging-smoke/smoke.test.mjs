import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import net from 'node:net';
import { validate, validateHealth, validateIdentity, identitySql } from './guards.mjs';
import { sealNetwork } from './network.mjs';
import { domainLoader, memoryTransport, composeIdentity } from './loader.mjs';
import { execute } from './run.mjs';
import { sign, validateFixture, createDomain } from './signature.mjs';
import { fixture } from './domain-fixture.mjs';

const root = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const smokeId = '00000000-0000-4000-8000-000000000123', commit = 'a'.repeat(40);
// Ephemeral dummy values: never stored, logged or used for a real connection.
function testDatabaseUrl(host, database) {
  const url = new URL('postgresql://' + host);
  url.pathname = '/' + database;
  url.username = randomBytes(8).toString('hex');
  url.password = randomBytes(16).toString('hex');
  url.searchParams.set('sslmode', 'verify-full');
  return url.toString();
}
function config() {
  const host = 'dpg-' + 'a'.repeat(20) + '-a.virginia-postgres.render.com';
  const target = { serviceId: 'srv-daif418ae00c73e8k2gg', serviceName: 'kidmais-manager-staging',
    origin: 'https://kidmais-manager-staging.onrender.com', branch: 'staging', database: 'kidmais_staging_fixture', hosts: [host] };
  const env = { NODE_ENV: 'production', RENDER: 'true', KIDMAIS_DEPLOY_ENV: 'staging',
    RENDER_SERVICE_ID: target.serviceId, RENDER_SERVICE_NAME: target.serviceName, RENDER_GIT_BRANCH: 'staging', RENDER_GIT_COMMIT: commit,
    IDENTIDADE_OTP_PROVIDER: 'gupshup', GUPSHUP_OTP_ENABLED: 'false', KIDMAIS_STAGING_OTP_DISABLED: 'SIM', FESTA_ENABLED: 'true',
    IDENTIDADE_OTP_PEPPER: randomBytes(32).toString('hex'),
    KIDMAIS_STAGING_DATABASE_URL: testDatabaseUrl(host, 'kidmais_staging_fixture') };
  return { env, target, args: { execute: true, commit, smokeId, contractId: '00000000-0000-4000-8000-000000000001' },
    git: { branch: 'staging', head: commit, staging: commit, dirty: '', origin: 'https://github.com/felipemenegaz-debug/kidmais-manager.git' } };
}
const goodHealth = { ok: true, status: 'degraded', components: { database: 'ready', festa: 'ready', otp: 'unavailable' }, otp: { provider: 'gupshup', configured: true, enabled: false, reason: 'staging_disabled' } };
const goodIdentity = { database: 'kidmais_staging_fixture', port: 5432, tls: true, superuser: false, create_db: false, create_role: false, replication: false, bypass_rls: false };

test('exact staging configuration permits TLS connection parameters; no permissive SSL', () => {
  const c = config(), p = validate(c.env, c.args, c.git, c.target);
  assert.equal(p.host, c.target.hosts[0]); assert.equal(p.database, c.target.database); assert.equal(p.ssl.rejectUnauthorized, true);
});
for (const [name, change] of [
  ['production environment', c => { c.env.KIDMAIS_DEPLOY_ENV = 'production'; }],
  ['production service even on staging branch', c => { c.env.RENDER_SERVICE_NAME = 'kidmais-manager-production'; }],
  ['wrong service ID', c => { c.env.RENDER_SERVICE_ID = 'other'; }],
  ['main branch', c => { c.git.branch = 'main'; }],
  ['commit mismatch', c => { c.env.RENDER_GIT_COMMIT = 'b'.repeat(40); }],
  ['dirty checkout', c => { c.git.dirty = ' M file'; }],
  ['wrong database', c => { c.env.KIDMAIS_STAGING_DATABASE_URL = c.env.KIDMAIS_STAGING_DATABASE_URL.replace('kidmais_staging_fixture', 'kidmais_manager'); }],
  ['wrong host', c => { c.env.KIDMAIS_STAGING_DATABASE_URL = c.env.KIDMAIS_STAGING_DATABASE_URL.replace(c.target.hosts[0], 'other.example'); }],
  ['TLS downgrade', c => { c.env.KIDMAIS_STAGING_DATABASE_URL = c.env.KIDMAIS_STAGING_DATABASE_URL.replace('verify-full', 'require'); }],
  ['query override', c => { c.env.KIDMAIS_STAGING_DATABASE_URL += '&host=other'; }],
  ['another DATABASE_URL', c => { c.env.DATABASE_URL = testDatabaseUrl(c.target.hosts[0], 'other'); }],
  ['external OTP enabled', c => { c.env.GUPSHUP_OTP_ENABLED = 'true'; }],
  ['external OTP ambiguous', c => { delete c.env.GUPSHUP_OTP_ENABLED; }],
  ['wrong provider', c => { c.env.IDENTIDADE_OTP_PROVIDER = 'console'; }],
  ['production credential present', c => { c.env.KIDMAIS_PRODUCTION_DATABASE_URL = 'not-read'; }],
  ['no manual CLI consent', c => { c.args.execute = false; }],
  ['empty target allowlist', c => { c.target.hosts = []; }],
  ['process injection option', c => { c.env.NODE_OPTIONS = '--require=anything'; }],
]) test(name + ' blocks before health, connection or writes', async () => {
  const c = config(); change(c); let calls = 0;
  await assert.rejects(execute({ ...c, health: async () => { calls++; }, connect: async () => { calls++; }, domain: () => { calls++; } }));
  assert.equal(calls, 0);
});

test('remote health must attest disabled OTP; physical TLS/database/role checked', () => {
  validateHealth(200, goodHealth); validateIdentity(goodIdentity, config().target);
  assert.throws(() => validateHealth(200, { ...goodHealth, otp: { ...goodHealth.otp, enabled: true } }));
  assert.throws(() => validateHealth(503, goodHealth));
  for (const patch of [{ tls: false }, { database: 'kidmais_manager' }, { port: 55432 }, { superuser: true }, { create_db: true }, { bypass_rls: true }]) {
    assert.throws(() => validateIdentity({ ...goodIdentity, ...patch }, config().target));
  }
});

test('all provider egress and arbitrary TCP blocked without performing network calls', () => {
  const restore = sealNetwork(config().target.hosts[0]);
  try {
    for (const invoke of [() => fetch('https://example.invalid'), () => http.get('http://example.invalid'),
      () => https.request('https://example.invalid'), () => http2.connect('https://example.invalid'),
      () => new net.Socket().connect(443, 'example.invalid')]) assert.throws(invoke, /FORBIDDEN/);
  } finally { restore(); }
});

test('memory OTP single consumption, no console output, no altered process env/module globals', async () => {
  const before = { ...process.env }, transport = memoryTransport(), logs = [];
  const old = console.log; console.log = (...args) => logs.push(args);
  try {
    await transport.send({ validacaoId: 'id', codigo: '123456', destino: '11900000000' });
    assert.equal(transport.take('id'), '123456'); assert.throws(() => transport.take('id'));
  } finally { console.log = old; transport.clear(); }
  assert.deepEqual(logs, []); assert(JSON.stringify({ ...process.env }) === JSON.stringify(before), 'Process environment unchanged');
});

test('provider module forbidden and web factory still blocks disabled OTP', () => {
  const c = config(), load = domainLoader(root, c.env);
  assert.throws(() => load('lib/identidade/delivery/otp.sender.ts'), /FORBIDDEN/);
  const real = load('lib/identidade/services/index.ts');
  assert.throws(() => real.criarIdentityServiceComAmbiente(async () => {}), e => e.code === 'OTP_INDISPONIVEL');
  const sender = async () => {}, cli = composeIdentity(real, c.env, sender);
  assert.throws(() => cli.criarIdentityServiceComAmbiente(async () => {}), /FOREIGN/);
  assert.throws(() => real.criarIdentityServiceComAmbiente(sender), e => e.code === 'OTP_INDISPONIVEL');
});

test('real identity + signature + formalization services, two signatures and one Festa, replay adds nothing', async () => {
  const f = fixture(root, config().env, smokeId), before = await f.read();
  assert.equal(before.assinaturas.length, 1); assert.equal(before.festas.length, 0);
  const result = await sign(f.domain, before, smokeId, commit, f.read);
  assert.equal(result.festas, 1); assert.equal(result.assinaturas, 2);
  for (const stage of ['challenge', 'confirm-code', 'consume-proof', 'mark-signed', 'signature-repository', 'formalization-validation', 'automatic-party']) assert(f.state.calls.includes(stage), stage);
  assert.equal(f.state.calls.filter(x => x === 'automatic-party').length, 1);
  assert.equal(f.state.validations[0].status, 'CONSUMIDA');
  assert.equal(f.state.validations[0].codigoHash.length, 64); assert(!('codigo' in f.state.validations[0]));
  const done = await f.read(), state = structuredClone(f.state);
  const replay = await sign(f.domain, done, smokeId, commit, f.read);
  assert.equal(replay.reutilizado, true); assert.deepEqual(f.state, state);
  assert.equal(done.smoke_audits.length, 1); assert.equal(done.smoke_audits[0].transport, 'MEMORY_ONLY');
  assert(!JSON.stringify(result).includes('provaToken')); assert(!JSON.stringify(result).includes('codigo'));
});

test('wrong identity/code and document hash are rejected by real domain', async () => {
  const f = fixture(root, config().env, smokeId), r = await f.read();
  await assert.rejects(f.domain.contracts.iniciarDesafioContrato({ contratoId: r.contrato_id, cpf: '00000000000', canal: 'WHATSAPP' }, f.domain.transport.send));
  const ch = await f.domain.contracts.iniciarDesafioContrato({ contratoId: r.contrato_id, cpf: r.cpf, canal: 'WHATSAPP' }, f.domain.transport.send);
  const code = f.domain.transport.take(ch.validacaoId);
  await assert.rejects(f.domain.identity.confirmarCodigo({ validacaoId: ch.validacaoId, codigo: code === '000000' ? '111111' : '000000' }), e => e.code === 'CODIGO_INVALIDO');
  const proof = await f.domain.identity.confirmarCodigo({ validacaoId: ch.validacaoId, codigo: code });
  await assert.rejects(f.domain.contracts.assinarContratoPublico({ contratoId: r.contrato_id, versaoId: r.versao_id,
    snapshotHash: r.snapshot_hash, documentoPdfHash: 'b'.repeat(64), acessoToken: ch.acessoToken, provaToken: proof.provaToken }, f.domain.transport.send), e => e.code === 'DOCUMENTO_CONTRATO_DIVERGENTE');
  assert.equal(f.state.signatures.length, 1); assert.equal(f.state.parties.length, 0);
});

test('unmarked customer, foreign signed flow and missing Kidmais signature refused', async () => {
  const f = fixture(root, config().env, smokeId), r = await f.read();
  for (const patch of [{ email: 'real@example.com' }, { nome_completo: 'Other' }, { assinaturas: [] }, { observacoes_equipe: '' }]) assert.throws(() => validateFixture({ ...r, ...patch }, smokeId));
  await sign(f.domain, r, smokeId, commit, f.read);
  const signed = await f.read();
  assert.throws(() => validateFixture({ ...signed, smoke_audits: [] }, smokeId));
});

test('CLI sanitizes failures and importing it never executes operations', () => {
  const r = spawnSync(process.execPath, [resolve(root, 'scripts/staging-smoke/run.mjs'), '--secret=123456'], { encoding: 'utf8', env: { SystemRoot: process.env.SystemRoot || '', PATH: process.env.PATH || '' } });
  assert.equal(r.status, 1); assert(!r.stdout.includes('123456')); assert(!r.stderr.includes('123456'));
  assert.equal(JSON.parse(r.stdout).code, 'STAGING_SMOKE_ABORTED');
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  for (const key of ['start', 'build', 'dev']) assert(!pkg.scripts[key].includes('staging-smoke'));
});

function coordinator(options = {}) {
  const c = config(), f = fixture(root, c.env, smokeId), commands = [];
  let snapshot, restored = 0, ended = 0;
  const client = { end: async () => { ended++; }, query: async sql => {
    commands.push(sql);
    if (sql === 'BEGIN' || sql === 'BEGIN READ ONLY') snapshot = structuredClone(f.state);
    else if (sql === 'ROLLBACK' && snapshot) Object.assign(f.state, structuredClone(snapshot));
    else if (sql === identitySql) return { rows: [{ ...goodIdentity, ...options.identity }] };
    else if (sql.startsWith('SELECT c.id AS contrato_id')) return { rows: [await f.read()] };
    return { rows: [] };
  } };
  return { f, commands, closed: () => ended === 1 && restored === 1,
    run: () => execute({ ...c, health: async () => ({ status: 200, body: goodHealth }), connect: async () => client,
      network: () => () => { restored++; }, domain: () => ({ ...f.domain, validateSchema: async () => {
        if (options.schemaFailure) throw new Error('schema fixture mismatch');
      } }) }) };
}

test('transaction coordinator commits real domain flow, preserves signed hashes and replays without mutations', async () => {
  const h = coordinator(), before = await h.f.read(), logs = [];
  const saved = Object.fromEntries(['log', 'info', 'warn', 'error', 'debug', 'trace'].map(k => [k, console[k]]));
  try {
    for (const k of Object.keys(saved)) console[k] = (...args) => logs.push(args);
    const r = await h.run(); assert.equal(r.festas, 1); assert(h.closed());
  } finally { Object.assign(console, saved); }
  assert.equal(logs.length, 0, 'Entire signature flow emits no console logs');
  const after = await h.f.read(); assert.equal(after.snapshot_hash, before.snapshot_hash); assert.equal(after.pdf_hash, before.pdf_hash);
  assert.equal(h.commands.at(-1), 'COMMIT');
  const state = structuredClone(h.f.state), second = await h.run();
  assert.equal(second.reutilizado, true); assert.deepEqual(h.f.state, state);
});

test('audit failure rolls back OTP, signatures, Festa, occupancy, events and all state', async () => {
  const h = coordinator(), before = structuredClone(h.f.state); h.f.failAudit();
  await assert.rejects(h.run(), /synthetic audit failure/);
  assert.deepEqual(h.f.state, before); assert(!h.commands.includes('COMMIT'));
  assert.equal(h.commands.at(-1), 'ROLLBACK'); assert(h.closed());
});

for (const [name, options] of [['physical database mismatch', { identity: { database: 'kidmais_manager' } }], ['schema mismatch', { schemaFailure: true }]]) {
  test(name + ' aborts in read-only transaction before domain writes', async () => {
    const h = coordinator(options), before = structuredClone(h.f.state);
    await assert.rejects(h.run()); assert(!h.commands.includes('BEGIN')); assert(h.closed());
    assert.deepEqual(h.f.state, before);
  });
}

test('pinned target contains identifiers only and accepts only the supplied internal hostname', () => {
  const target = JSON.parse(readFileSync(resolve(root, 'scripts/staging-smoke/target.json'), 'utf8'));
  assert.equal(target.database, 'kidmais_staging_1z91');
  assert.equal(target.databaseServiceName, 'kidmais-staging');
  assert.deepEqual(target.hosts, ['dpg-daidko3m8hqs73ce4jt0-a']);
  const c = config(); c.target = target;
  c.env.KIDMAIS_STAGING_DATABASE_URL = testDatabaseUrl(target.hosts[0], target.database);
  assert.equal(validate(c.env, c.args, c.git, c.target).ssl.rejectUnauthorized, true);
  c.env.KIDMAIS_STAGING_DATABASE_URL = c.env.KIDMAIS_STAGING_DATABASE_URL.replace(target.hosts[0], target.hosts[0] + '.virginia-postgres.render.com');
  assert.throws(() => validate(c.env, c.args, c.git, c.target));
});

test('CLI composes entire unmocked module graph offline and uses only its guarded database executor', async () => {
  let queries = 0;
  const restore = sealNetwork(config().target.hosts[0]);
  try {
    const domain = createDomain(root, config().env, { query: async () => { queries++; throw new Error('synthetic executor stop'); } });
    assert.equal(queries, 0);
    await assert.rejects(domain.validateSchema()); assert.equal(queries, 1);
  } finally { restore(); }
});

test('operational files contain no complete database URL or literal connection credentials', () => {
  const dir = resolve(root, 'scripts/staging-smoke');
  for (const file of readdirSync(dir)) {
    const source = readFileSync(resolve(dir, file), 'utf8');
    assert(!/postgres(?:ql)?:\/\/[^\s'"`]*:[^\s'"`]*@/i.test(source), 'No embedded connection URL');
    assert(!/\b(?:user(?:name)?|password)\s*[:=]\s*['"][^'"]+['"]/i.test(source), 'No literal connection credentials');
  }
});
