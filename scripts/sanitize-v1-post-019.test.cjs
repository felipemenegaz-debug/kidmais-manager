'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
// This test process cannot launch PostgreSQL, including accidentally through defaults.
let processAttempts = 0;
cp.spawn = cp.exec = cp.execFile = cp.spawnSync = cp.execSync = () => { processAttempts++; throw new Error('PROCESS_FORBIDDEN_IN_UNIT_TESTS'); };
cp.execFileSync = () => { processAttempts++; throw new Error('PROCESS_FORBIDDEN_IN_UNIT_TESTS'); };
const guards = require('./sanitize-v1-post-019/guards.cjs');
const checks = require('./sanitize-v1-post-019/checks.cjs');
const tx = require('./sanitize-v1-post-019/transaction.cjs');
const attest = require('./sanitize-v1-post-019/attestation.cjs');
const fixture = require('./sanitize-v1-post-019/fixture.cjs');
const integration = require('./sanitize-v1-post-019.integration.cjs');
const { main, manifests } = require('./sanitize-v1-post-019.cjs');
const clone = value => structuredClone(value);
const argv = ['--host', '127.0.0.1', '--port', '55429', '--user', guards.TARGET.user, '--database', guards.TARGET.database];
const authorization = `${guards.TARGET.host}:${guards.TARGET.port}/${guards.TARGET.database}`;
const fixedTimes = { startedAt: fixture.FIXED_TIME, completedAt: fixture.FIXED_TIME };
const expectedFiles = [
  '20260907_001_crm_extensions.sql', '20260907_002_crm_people.sql', '20260907_003_crm_history_audit.sql',
  '20260907_004_crm_duplicates_merge.sql', '20260907_005_disponibilidade_base.sql',
  '20260907_006_comercial_base.sql', '20260907_006a_comercial_precos_patch.sql',
  '20260908_007_fechamento_base.sql', '20260908_008_identidade_cliente.sql', '20260908_009_contrato_base.sql',
  '20260908_010_contrato_documento_aceite.sql', '20260908_011_pagamentos_base.sql',
  '20260909_012_condicao_pagamento.sql', '20260909_013_autenticacao_contrato.sql',
  '20260909_014_revisao_operacional.sql', '20260910_015_tratamento_financeiro.sql',
  '20260911_016_festa.sql', '20260912_017_pocket_sexta.sql',
  '20260912_018_whatsapp_onboarding.sql', '20260915_019_festa_formalizacao.sql',
].map(file => `database/migrations/${file}`);
const sourceRows = manifests.schema.sources.map(({ path: file, sql }) => ({ path: file, sql }));

function mockManifests() {
  return clone(manifests);
}
function snapshotData(empty = false) {
  return { inventory: Object.fromEntries(Object.entries(manifests.schema.tables).map(([t, c]) => [t, Object.keys(c)])),
    catalog: clone(manifests.catalog.tables),
    counts: Object.fromEntries(Object.entries(manifests.policy.tables).map(([t, p]) => [t, p === 'EMPTY' ? (empty ? 0 : 1) : manifests.catalog.tables[t].length])),
    structure_sha256: manifests.schema.physical_projection.sha256, catalog_identity_sha256: 'b'.repeat(64), hazards: 0,
    sequence_states: { festa_contagens_convidados_sequencia_seq: { value: 5, called: true }, festa_eventos_sequencia_seq: { value: 7, called: true } } };
}
function setup({ failure, alterSnapshot, preflight = {} } = {}) {
  const issued = []; let currentReadOnly = true; let calls = 0; let closed = false;
  const session = {
    async command(sql) {
      issued.push(sql);
      if (failure?.(sql)) throw Object.assign(new Error('SYNTHETIC_PRIVATE_CANARY_019'), { code: 'PROCESS_FAILED' });
      if (sql.includes('READ WRITE')) currentReadOnly = false;
      if (sql === 'ROLLBACK;') return ['ROLLBACK'];
      if (sql === 'COMMIT;') return ['COMMIT'];
      return [];
    },
    async json() { return { database: guards.TARGET.database, host: guards.TARGET.host, port: guards.TARGET.port,
      user: guards.TARGET.user, default_read_only: 'on', read_only: currentReadOnly ? 'on' : 'off', encoding: 'UTF8', version_num: 180006, ...preflight }; },
    close() { closed = true; },
  };
  const m = mockManifests();
  const options = { mode: 'apply', target: guards.TARGET, authorized: true,
    planDigest: tx.planFor(guards.TARGET, m, snapshotData()).digest };
  const deps = { sessionFactory: () => session,
    readSnapshot: async (_s, _m, post) => { const data = snapshotData(post); calls++; alterSnapshot?.(data, calls); return data; } };
  return { issued, m, options, deps, closed: () => closed };
}

test('policy exact 63 / 9 / 54, unknown policies and altered sets refused', () => {
  checks.assertPolicy(manifests.policy);
  assert.equal(Object.keys(manifests.policy.tables).length, 63);
  for (const [rule, count] of [['EMPTY', 54], ['PRESERVE_CANONICAL', 9]]) assert.equal(Object.values(manifests.policy.tables).filter(v => v === rule).length, count);
  const bad = clone(manifests.policy); bad.tables.clientes = 'TRANSFORM'; assert.throws(() => checks.assertPolicy(bad), /POLICY_INVALID/);
  const extra = clone(manifests.policy); extra.tables.surprise = 'EMPTY'; assert.throws(() => checks.assertPolicy(extra), /POLICY_INVALID/);
  const swap = clone(manifests.policy); swap.tables.clientes = 'PRESERVE_CANONICAL'; swap.tables.adicionais = 'EMPTY';
  assert.throws(() => checks.assertPolicy(swap), /POLICY_INVALID/);
  const rename = clone(manifests.policy); delete rename.tables.clientes; rename.tables.surprise = 'EMPTY';
  assert.throws(() => checks.assertPolicy(rename), /POLICY_INVALID/);
});
test('logical schema and catalog regenerate from 20 embedded pinned Git blobs; no Git or DB process', () => {
  assert.deepEqual(manifests.schema.sources.map(s => s.path), expectedFiles);
  const logical = checks.deriveSchema(sourceRows);
  assert.deepEqual(logical, { ...manifests.schema, physical_projection: null, execution_gate: logical.execution_gate });
  assert.deepEqual(checks.deriveCatalog(sourceRows, manifests.schema), manifests.catalog);
  assert.equal(guards.hash(sourceRows.at(-1).sql), checks.MIGRATION_019);
  assert.equal(Object.values(manifests.schema.tables).reduce((n, cols) => n + Object.keys(cols).length, 0), 862);
  assert.equal(Object.keys(manifests.schema.functions).length, 39);
  checks.assertManifests(manifests);
  for (const source of sourceRows) {
    const workingPath = path.join(__dirname, '..', source.path);
    if (fs.existsSync(workingPath)) assert.equal(guards.hash(fs.readFileSync(workingPath, 'utf8').replace(/\r\n/g, '\n')), guards.hash(source.sql));
  }
});
test('all nine catalog projections include every non-technical column', () => {
  for (const [table, rows] of Object.entries(manifests.catalog.tables)) {
    const columns = Object.keys(manifests.schema.tables[table]).filter(c => !checks.TECHNICAL.includes(c)).sort();
    for (const row of rows) assert.deepEqual(Object.keys(row).sort(), columns);
    assert.equal(new Set(rows.map(guards.stable)).size, rows.length);
  }
  assert.equal(manifests.catalog.tables.precos_pacote.length, 69);
  assert.equal(manifests.catalog.tables.regras_disponibilidade_pacote.length, 99);
  const prices = manifests.catalog.tables.precos_pacote;
  assert.deepEqual(['GERAL', 'PADRAO', 'NOBRE'].map(c => prices.filter(r => r.categoria_horario === c).length), [3, 33, 33]);
});
test('catalog checks content not counts; a changed note, value or key is refused', () => {
  for (const key of ['codigo', 'nome', 'observacoes']) {
    const data = clone(manifests.catalog.tables); data.tabelas_preco[0][key] = 'unexpected';
    assert.throws(() => checks.assertCatalog(data, manifests.catalog), /CATALOG_MISMATCH/);
  }
  const data = clone(manifests.catalog.tables); data.precos_pacote[0].valor++;
  assert.throws(() => checks.assertCatalog(data, manifests.catalog), /CATALOG_MISMATCH/);
});
test('both protected databases rejected before any process', () => {
  for (const database of ['kidmais_manager', 'kidmais_v1_homologacao']) assert.throws(() => guards.guardTarget({ ...guards.TARGET, database }), /TARGET_REFUSED/);
});
test('only exact host, port, user and allowed database; no DNS or conninfo', () => {
  for (const host of ['localhost', '::1', '127.0.0.2', 'remote.example']) assert.throws(() => guards.guardTarget({ ...guards.TARGET, host }), /TARGET_REFUSED/);
  for (const value of [{ port: 5432 }, { database: 'dbname=x host=remote' }, { user: 'postgres options=x' }]) assert.throws(() => guards.guardTarget({ ...guards.TARGET, ...value }), /TARGET_REFUSED/);
});
test('dry-run default with mandatory explicit coordinates', () => {
  assert.equal(guards.parseArgs(argv).mode, 'dry-run');
  assert.equal(guards.parseArgs([...argv, '--verify']).mode, 'verify');
  assert.throws(() => guards.parseArgs([]), /INVALID_ARGUMENT/);
});
test('apply needs explicit target authorization and plan digest', () => {
  assert.throws(() => guards.parseArgs([...argv, '--apply']), /AUTHORIZATION_REQUIRED/);
  assert.throws(() => guards.parseArgs([...argv, '--apply', '--authorize-target', authorization]), /DIGEST_MISMATCH/);
  assert.equal(guards.parseArgs([...argv, '--apply', '--authorize-target', authorization, '--plan-digest', 'a'.repeat(64)]).mode, 'apply');
  assert.throws(() => guards.assertDigest('a'.repeat(64), 'b'.repeat(64)), /DIGEST_MISMATCH/);
});
test('password, unknown, repeated, ambiguous args refused', () => {
  for (const extra of [['--password', 'SYNTHETIC_PRIVATE_CANARY_019'], ['--host', '127.0.0.1'], ['--apply', '--verify'], ['--env-file', 'x'], ['--verify', '--plan-digest', 'a'.repeat(64)]]) assert.throws(() => guards.parseArgs([...argv, ...extra]));
});
test('native child environment never reads secret or fallback fields', () => {
  const accesses = [];
  const parent = new Proxy({ SystemRoot: 'C:\\Windows', APPDATA: 'C:\\SYNTHETIC' }, { get(o, k) { accesses.push(k); if (!Object.hasOwn(o, k)) throw new Error('forbidden environment read'); return o[k]; } });
  const env = guards.nativeEnvironment(parent);
  assert.ok(accesses.every(k => ['SystemRoot', 'APPDATA'].includes(k)));
  assert.ok(env.PGOPTIONS.includes('default_transaction_read_only=on'));
  assert.equal(Object.keys(env).length, 5);
});
test('physical seal is strict and refuses altered projection or recipe metadata', () => {
  checks.assertSealed(manifests.schema);
  for (const mutate of [
    s => { s.execution_gate = 'B5B2_DISPOSABLE_NATIVE_PROJECTION_REVIEW_REQUIRED'; },
    s => { s.physical_projection = null; },
    s => { s.physical_projection.sha256 = 'a'.repeat(64); },
    s => { s.physical_projection.reference_recipe_sha256 = 'b'.repeat(64); },
    s => { s.physical_projection.reference_executor_sha256 = 'c'.repeat(64); },
    s => { s.physical_projection.canonicalization = 'OTHER'; },
    s => { delete s.physical_projection.component_sha256.roles; },
  ]) { const schema = clone(manifests.schema); mutate(schema); assert.throws(() => checks.assertSealed(schema), /BASELINE_UNSEALED/); }
});
test('sealed projection fingerprints all 22 reviewed semantic components', () => {
  const projection = manifests.schema.physical_projection;
  assert.equal(Object.keys(projection.component_sha256).length, 22);
  assert.equal(projection.canonicalization, tx.CANONICALIZATION);
  for (const key of ['acl', 'triggers', 'functions', 'types', 'roles', 'memberships', 'role_settings', 'default_privileges']) {
    assert.match(projection.component_sha256[key], /^[a-f0-9]{64}$/);
  }
  assert.match(tx.STRUCTURE, /INTERNAL_CONSTRAINT/);
  assert.match(tx.STRUCTURE, /pg_get_function_arguments/);
  assert.match(tx.STRUCTURE, /pg_get_userbyid\(t\.typowner\)/);
  assert.match(tx.STRUCTURE, /acl_projection/);
});
test('reference recipe and runtime share the exact isolated target and dedicated role', () => {
  const recipe = require('./sanitize-v1-post-019/reference-bootstrap.json');
  const recipeText = fs.readFileSync(path.join(__dirname, 'sanitize-v1-post-019/reference-bootstrap.json'), 'utf8').replace(/\r\n?/g, '\n');
  const executorText = fs.readFileSync(path.join(__dirname, 'sanitize-v1-post-019.reference.ps1'), 'utf8').replace(/\r\n?/g, '\n');
  const checksText = fs.readFileSync(path.join(__dirname, 'sanitize-v1-post-019/checks.cjs'), 'utf8');
  assert.equal(guards.hash(recipeText), manifests.schema.physical_projection.reference_recipe_sha256);
  assert.equal(guards.hash(executorText), manifests.schema.physical_projection.reference_executor_sha256);
  assert.equal(recipe.reference_executor_sha256, manifests.schema.physical_projection.reference_executor_sha256);
  assert.ok(checksText.includes(`const REFERENCE_RECIPE_SHA256 = '${guards.hash(recipeText)}'`));
  assert.ok(checksText.includes(`const REFERENCE_EXECUTOR_SHA256 = '${guards.hash(executorText)}'`));
  assert.deepEqual(recipe.target, { host: guards.TARGET.host, port: guards.TARGET.port, database: guards.TARGET.database });
  assert.equal(recipe.roles.sanitizer, guards.TARGET.user);
  assert.equal(recipe.roles.sanitizer_connection_limit, 1);
  assert.equal(recipe.roles.temporary, false);
  assert.deepEqual(recipe.roles.sequence_privileges, ['SELECT']);
  assert.equal(recipe.postgresql.exact_version_num, 180006);
  assert.equal(recipe.verification_mode_required_after_seal, true);
  assert.equal(recipe.locking.empty_tables, 'ACCESS EXCLUSIVE');
  assert.equal(recipe.locking.preserve_canonical_tables, 'ACCESS SHARE');
});
test('programmatic execution also fails closed before process for unsealed manifest', async () => {
  let calls = 0;
  const unsealed = clone(manifests); unsealed.schema.physical_projection = null;
  unsealed.schema.execution_gate = 'B5B2_DISPOSABLE_NATIVE_PROJECTION_REVIEW_REQUIRED';
  await assert.rejects(() => tx.execute({ target: guards.TARGET, mode: 'dry-run' }, unsealed, { sessionFactory: () => { calls++; } }), /BASELINE_UNSEALED/);
  assert.equal(calls, 0);
});
test('unknown table and column refused', () => {
  const base = snapshotData().inventory;
  checks.assertInventory(base, manifests.schema, manifests.policy);
  assert.throws(() => checks.assertInventory({ ...base, extra: ['id'] }, manifests.schema, manifests.policy), /SCHEMA_MISMATCH/);
  const bad = clone(base); bad.clientes.push('extra');
  assert.throws(() => checks.assertInventory(bad, manifests.schema, manifests.policy), /SCHEMA_MISMATCH/);
});
test('one explicit qualified TRUNCATE of exactly 54 tables, locks all 63', () => {
  const sql = tx.destructiveSQL(manifests.policy);
  assert.equal((sql.match(/TRUNCATE/g) || []).length, 1);
  assert.equal((sql.match(/public\./g) || []).length, 54);
  assert.ok(sql.endsWith('CONTINUE IDENTITY RESTRICT;'));
  assert.doesNotMatch(sql, /RESTART IDENTITY|setval|ALTER SEQUENCE/i);
  const locks = tx.locksSQL(manifests.policy);
  assert.equal((locks.match(/public\./g) || []).length, 63);
  assert.match(locks, /ACCESS EXCLUSIVE MODE;\nLOCK TABLE/);
  assert.match(locks, /ACCESS SHARE MODE;$/);
  assert.doesNotMatch(sql, /CASCADE|DISABLE\s+TRIGGER|session_replication_role|DROP\s+CONSTRAINT/i);
});
test('63 counts do not exceed PostgreSQL function argument limit', () => {
  const sql = tx.countsSQL(manifests.policy);
  assert.match(sql, /jsonb_object_agg\(table_name,row_count\)/);
  assert.equal((sql.match(/count\(\*\)/g) || []).length, 63);
  assert.doesNotMatch(sql, /json_build_object/);
});
test('source snapshot tampering refuses before any execution', () => {
  const m = clone(manifests); m.schema.sources[0].sql += '\n';
  assert.throws(() => checks.assertManifests(m), /SOURCE_MISMATCH/);
  const partition = clone(manifests); delete partition.catalog.tables.pacotes;
  assert.throws(() => checks.assertManifests(partition), /MANIFEST_INVALID/);
});
test('pure psql protocol parsing supports fragmented CRLF frames without spawning', async () => {
  const session = Object.create(tx.PsqlSession.prototype);
  Object.assign(session, { pending: null, buffer: '', closed: false, sequence: 0 });
  let request = '';
  session.child = { stdin: { write: sql => { request = sql; }, end() {} }, kill() {} };
  const pending = session.json('SELECT 1;');
  const marker = request.match(/\\echo (\S+)/)[1];
  session.receive('{"ok":'); session.receive('true}\r\n');
  session.receive(marker.slice(0, 7)); session.receive(`${marker.slice(7)} false 00000\r\n`);
  assert.deepEqual(await pending, { ok: true });
  assert.equal(session.pending, null);
  session.close();
});
test('pure psql protocol rejects raw unexpected lines and reports close failures safely', async () => {
  const session = Object.create(tx.PsqlSession.prototype);
  Object.assign(session, { pending: null, buffer: '', closed: false, sequence: 0 });
  let request = '';
  session.child = { stdin: { write: sql => { request = sql; }, end() {} }, kill() {} };
  const malformed = session.json('SELECT 1;');
  let marker = request.match(/\\echo (\S+)/)[1];
  session.receive(`SYNTHETIC_PRIVATE_CANARY_019\n${marker}\n`);
  await assert.rejects(malformed, /PROTOCOL_FAILED/);
  const lost = session.command('COMMIT;');
  marker = request.match(/\\echo (\S+)/)[1];
  assert.ok(marker.startsWith('SANITIZER_'));
  session.fail();
  await assert.rejects(lost, /PROCESS_FAILED/);
  session.close();
});
test('psql SQLSTATE frame keeps session alive for explicit ROLLBACK', async () => {
  const session = Object.create(tx.PsqlSession.prototype);
  Object.assign(session, { pending: null, buffer: '', closed: false, aborted: false, sequence: 0 });
  let request = '';
  session.child = { stdin: { write: sql => { request = sql; }, end() {} }, kill() {} };
  const failed = session.command('SELECT 1/0;');
  const marker = request.match(/\\echo (\S+)/)[1];
  session.receive(`${marker} true 22012\n`);
  await assert.rejects(failed, error => error.code === 'SQL_FAILED' && error.sqlstate === '22012');
  await assert.rejects(session.command('COMMIT;'), /PROTOCOL_FAILED/);
  const rollback = session.command('ROLLBACK;');
  const rollbackMarker = request.match(/\\echo (\S+)/)[1];
  session.receive(`ROLLBACK\n${rollbackMarker} false 00000\n`);
  assert.deepEqual(await rollback, ['ROLLBACK']);
  assert.equal(session.aborted, false);
  session.close();
});
test('runtime sources have no forbidden mutation or environment reader', () => {
  for (const file of ['guards.cjs', 'checks.cjs', 'transaction.cjs', 'attestation.cjs', 'fixture.cjs']) {
    const text = fs.readFileSync(path.join(__dirname, 'sanitize-v1-post-019', file), 'utf8');
    assert.doesNotMatch(text, /DISABLE\s+TRIGGER|session_replication_role|\bCASCADE\b|DROP\s+CONSTRAINT/i);
    assert.doesNotMatch(text, /DATABASE_URL|dotenv|\.env\.local|--env-file/);
  }
  const text = fs.readFileSync(path.join(__dirname, 'sanitize-v1-post-019/transaction.cjs'), 'utf8');
  assert.match(text, /shell: false/); assert.match(text, /'-X', '-w'/);
});
test('preflight checks database host port user encoding and both read-only flags', () => {
  const row = { database: guards.TARGET.database, host: '127.0.0.1', port: 55429, user: guards.TARGET.user, default_read_only: 'on', read_only: 'on', encoding: 'UTF8', version_num: 180006 };
  guards.assertPreflight(row, guards.TARGET);
  for (const [key, value] of Object.entries({ database: 'kidmais_manager', host: '::1', port: 5432, user: 'other', default_read_only: 'off', read_only: 'off', encoding: 'LATIN1', version_num: 170000 })) assert.throws(() => guards.assertPreflight({ ...row, [key]: value }, guards.TARGET), /PREFLIGHT_FAILED/);
});
test('plan digest binds policy, target, schema, catalog, counts and SQL', () => {
  const base = setup();
  const plan = tx.planFor(guards.TARGET, base.m, snapshotData());
  const changed = snapshotData(); changed.counts.clientes++;
  assert.notEqual(plan.digest, tx.planFor(guards.TARGET, base.m, changed).digest);
  const newIdentities = snapshotData(); newIdentities.catalog_identity_sha256 = 'c'.repeat(64);
  assert.notEqual(plan.digest, tx.planFor(guards.TARGET, base.m, newIdentities).digest);
  const m = clone(base.m); m.catalog.tables.pacotes[0].nome += 'x';
  assert.throws(() => tx.planFor(guards.TARGET, m, snapshotData()), /MANIFEST_INVALID/);
  const changedSchema = clone(base.m); changedSchema.schema.physical_projection.sha256 = 'd'.repeat(64);
  assert.notEqual(plan.digest, tx.planFor(guards.TARGET, changedSchema, snapshotData()).digest);
});
test('mock dry-run rolls back, returns PLAN never PASS, does not mutate', async () => {
  const s = setup(); const out = await tx.execute({ ...s.options, mode: 'dry-run' }, s.m, s.deps);
  assert.equal(out.status, 'PLAN'); assert.equal(out.rollbackConfirmed, true);
  assert.ok(s.issued.includes('ROLLBACK;')); assert.ok(s.issued.every(q => !q.startsWith('TRUNCATE') && !q.includes('READ WRITE'))); assert.ok(s.closed());
});
test('mock verify certifies existing empty state only, with ROLLBACK', async () => {
  const s = setup(); const out = await tx.execute({ ...s.options, mode: 'verify' }, s.m, s.deps);
  assert.equal(out.status, 'PASS'); assert.equal(out.commitConfirmed, false); assert.equal(out.rollbackConfirmed, true);
});
test('mock apply locks and rechecks before single truncate then postchecks and COMMIT', async () => {
  const s = setup(); const out = await tx.execute(s.options, s.m, s.deps);
  assert.equal(out.status, 'PASS'); assert.equal(out.commitConfirmed, true);
  const lock = s.issued.findIndex(q => q.startsWith('LOCK TABLE'));
  const truncate = s.issued.findIndex(q => q.startsWith('TRUNCATE'));
  assert.ok(lock > 0 && truncate > lock);
  assert.equal(s.issued.filter(q => q.startsWith('TRUNCATE')).length, 1);
  assert.equal(s.issued.at(-1), 'COMMIT;'); assert.ok(s.closed());
});
test('drift under locks refuses truncate and rolls back', async () => {
  const s = setup({ alterSnapshot: (data, call) => { if (call === 2) data.counts.clientes++; } });
  const out = await tx.execute(s.options, s.m, s.deps);
  assert.equal(out.status, 'FAIL'); assert.equal(out.code, 'DIGEST_MISMATCH'); assert.equal(out.rollbackConfirmed, true);
  assert.ok(s.issued.every(q => !q.startsWith('TRUNCATE')));
});
test('preflight mismatch aborts before inspection or mutation', async () => {
  let snapshots = 0; const s = setup({ preflight: { database: 'kidmais_manager' } });
  s.deps.readSnapshot = async () => { snapshots++; };
  const out = await tx.execute(s.options, s.m, s.deps);
  assert.equal(out.code, 'PREFLIGHT_FAILED'); assert.equal(snapshots, 0); assert.equal(s.issued.at(-1), 'ROLLBACK;');
});
test('mutation failure and nonempty postcheck rollback; no commit', async () => {
  for (const config of [{ failure: sql => sql.startsWith('TRUNCATE') }, { alterSnapshot: (d, call) => { if (call === 3) d.counts.clientes = 1; } }]) {
    const s = setup(config); const out = await tx.execute(s.options, s.m, s.deps);
    assert.equal(out.status, 'FAIL'); assert.equal(out.rollbackConfirmed, true); assert.ok(!s.issued.includes('COMMIT;'));
  }
});
test('precommit failure without acknowledged ROLLBACK remains transaction outcome unknown', async () => {
  const s = setup({ failure: sql => sql.startsWith('TRUNCATE') || sql === 'ROLLBACK;' });
  const out = await tx.execute(s.options, s.m, s.deps);
  assert.equal(out.status, 'FAIL'); assert.equal(out.rollbackConfirmed, false);
  assert.equal(out.transactionOutcome, 'TRANSACTION_OUTCOME_UNKNOWN');
  const proof = attest.attest(out, s.options, s.m, fixedTimes);
  assert.equal(proof.transaction_outcome, 'TRANSACTION_OUTCOME_UNKNOWN');
  assert.throws(() => attest.validateAttestation({ ...proof, rollback_confirmed: true }), /ATTESTATION_INVALID/);
});
test('sequence state drift is bound by plan and rejected at postcheck', () => {
  const m = mockManifests();
  const before = snapshotData(); const after = snapshotData(true);
  after.sequence_states.festa_eventos_sequencia_seq.value++;
  assert.notEqual(tx.planFor(guards.TARGET, m, before).digest, tx.planFor(guards.TARGET, m, after).digest);
  assert.throws(() => checks.assertSnapshot(after, m.schema, m.catalog, m.policy, true, before), /POSTCHECK_FAILED/);
});
test('reference startup classifies restricted-token failure without target fallback or retry', () => {
  const source = fs.readFileSync(path.join(__dirname, 'sanitize-v1-post-019.reference.ps1'), 'utf8');
  assert.match(source, /WINDOWS_RESTRICTED_TOKEN/);
  assert.match(source, /FRESH_CLUSTER_REQUIRED/);
  assert.match(source, /AUTHORIZED_PORT_ALREADY_IN_USE/);
  assert.doesNotMatch(source, /Start-Sleep|Retry-Count|port\s*=\s*5432/i);
});
test('schema, hazards, catalog preservation and sequences required for postcheck', () => {
  const m = mockManifests();
  for (const change of [{ hazards: 1 }, { structure_sha256: 'c'.repeat(64) }, { sequence_states: { festa_eventos_sequencia_seq: { value: 1, called: false } } }, { catalog_identity_sha256: 'd'.repeat(64) }]) {
    assert.throws(() => checks.assertSnapshot({ ...snapshotData(true), ...change }, m.schema, m.catalog, m.policy, true, snapshotData()), /POSTCHECK_FAILED/);
  }
});
test('connection failure after sending COMMIT is UNKNOWN, never retried', async () => {
  const s = setup({ failure: sql => sql === 'COMMIT;' }); const out = await tx.execute(s.options, s.m, s.deps);
  assert.equal(out.status, 'COMMIT_UNKNOWN'); assert.equal(out.commitConfirmed, false);
  assert.equal(out.transactionOutcome, 'COMMIT_OUTCOME_UNKNOWN');
  assert.equal(s.issued.filter(q => q === 'COMMIT;').length, 1); assert.equal(s.issued.at(-1), 'COMMIT;');
});
test('attestation generation and strict validation rejects sensitive and arbitrary nested fields', async () => {
  const s = setup(); const out = await tx.execute(s.options, s.m, s.deps);
  const value = attest.attest(out, s.options, s.m, fixedTimes);
  assert.equal(value.result, 'PASS'); assert.equal(Object.keys(value.counts).length, 63);
  assert.equal(value.physical_fingerprint_sha256, manifests.schema.physical_projection.sha256);
  assert.equal(value.physical_components_digest_sha256, guards.hash(guards.stable(manifests.schema.physical_projection.component_sha256)));
  assert.equal(value.reference_recipe_sha256, manifests.schema.physical_projection.reference_recipe_sha256);
  assert.equal(value.reference_executor_sha256, manifests.schema.physical_projection.reference_executor_sha256);
  assert.deepEqual([value.table_count, value.empty_table_count, value.canonical_table_count], [63, 54, 9]);
  assert.equal(value.sequences_preserved, true); assert.equal(value.identities_restarted, false);
  assert.ok(value.limitations.includes('IDENTITIES_NOT_RESTARTED'));
  for (const alteration of [{ sequences_preserved: false }, { identities_restarted: true }, { physical_fingerprint_sha256: '0'.repeat(64) }])
    assert.throws(() => attest.validateAttestation({ ...value, ...alteration }), /ATTESTATION_INVALID/);
  for (const key of ['cpf', 'telefone', 'email', 'token', 'password', 'operational_id', 'pii_hash', 'debug']) {
    assert.throws(() => attest.validateAttestation({ ...value, [key]: 'SYNTHETIC_PRIVATE_CANARY_019' }), /ATTESTATION_INVALID/);
    assert.throws(() => attest.validateAttestation({ ...value, target: { ...value.target, [key]: 'x' } }), /ATTESTATION_INVALID/);
  }
  assert.throws(() => attest.validateAttestation({ ...value, code: 'SYNTHETIC_PRIVATE_CANARY_019' }), /ATTESTATION_INVALID/);
  assert.throws(() => attest.validateAttestation({ ...value, mode: 'dry-run' }), /ATTESTATION_INVALID/);
  assert.throws(() => attest.validateAttestation({ ...value, commit_confirmed: false }), /ATTESTATION_INVALID/);
});
test('independent verify certifies empty state but not temporal sequence preservation', async () => {
  const s = setup(); const options = { ...s.options, mode: 'verify' };
  const out = await tx.execute(options, s.m, s.deps);
  const value = attest.attest(out, options, s.m, fixedTimes);
  assert.equal(value.result, 'PASS'); assert.equal(value.sequences_preserved, false);
  assert.equal(value.identities_restarted, false);
  assert.throws(() => attest.validateAttestation({ ...value, sequences_preserved: true }), /ATTESTATION_INVALID/);
});
test('post-commit output failure has distinct state; no repeated destructive action', async () => {
  const s = setup(); const out = await tx.execute(s.options, s.m, s.deps);
  const value = await attest.publish(out, s.options, s.m, fixedTimes, async () => { throw new Error('SYNTHETIC_PRIVATE_CANARY_019'); });
  assert.equal(value.result, 'COMMIT_CONFIRMED_ATTESTATION_FAILED');
  assert.equal(s.issued.filter(q => q.startsWith('TRUNCATE')).length, 1);
});
test('publication failure preserves COMMIT_UNKNOWN and rejects contradictory attestations', async () => {
  const s = setup({ failure: sql => sql === 'COMMIT;' });
  const out = await tx.execute(s.options, s.m, s.deps);
  const value = attest.attest(out, s.options, s.m, fixedTimes);
  assert.throws(() => attest.validateAttestation({ ...value, rollback_confirmed: true }), /ATTESTATION_INVALID/);
  assert.throws(() => attest.validateAttestation({ ...value, mode: 'verify' }), /ATTESTATION_INVALID/);
  const publication = await attest.publish(out, s.options, s.m, fixedTimes, async () => { throw new Error('closed output'); });
  assert.equal(publication.result, 'COMMIT_UNKNOWN');
  const success = setup(); const good = await tx.execute(success.options, success.m, success.deps);
  const pass = attest.attest(good, success.options, success.m, fixedTimes);
  assert.throws(() => attest.validateAttestation({ ...pass, rollback_confirmed: true }), /ATTESTATION_INVALID/);
});
test('logs never contain sensitive fixture canaries, raw errors or payloads', async () => {
  const s = setup({ failure: sql => sql.startsWith('TRUNCATE') });
  const out = await tx.execute(s.options, s.m, s.deps); const lines = [];
  await attest.publish(out, s.options, s.m, fixedTimes, async value => lines.push(value));
  const log = lines.join('');
  for (const canary of ['SYNTHETIC_PRIVATE_CANARY_019', fixture.fixture().cliente.email, fixture.fixture().cliente.id]) assert.ok(!log.includes(canary));
  assert.match(log, /PROCESS_FAILED/);
});
test('fixture deterministic, disconnected, no load capability', () => {
  assert.deepEqual(fixture.fixture(), fixture.fixture());
  assert.equal(fixture.fixture().externalTransport, 'DISABLED');
  const sql = fs.readFileSync(path.join(__dirname, 'sanitize-v1-post-019', 'fixture.sql'), 'utf8').replace(/\r\n?/g, '\n');
  assert.equal(guards.hash(sql), fixture.SQL_SHA256);
  assert.match(sql, /^-- B5B-2B:[\s\S]*\nBEGIN;/);
  assert.doesNotMatch(sql, /DISABLE\s+TRIGGER|session_replication_role|DATABASE_URL|kidmais_manager|kidmais_v1_homologacao/i);
  assert.throws(() => fixture.loadFixture(), /FIXTURE_REFUSED/);
});
test('integration harness inspected structurally, not executed', () => {
  const state = integration.readiness();
  assert.equal(state.databaseAccessEnabled, false); assert.equal(state.sealed, true);
  assert.ok(state.cases.includes('ONE_TRUNCATE_54'));
});
test('non-execution evidence: zero prohibited child-process attempts in entire suite', () => {
  assert.equal(processAttempts, 0);
});
