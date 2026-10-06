import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import * as database from './check-database-target.mjs';
import * as envCheck from './check-env.mjs';
import * as migrations from './check-migrations.mjs';
import * as smoke from './smoke-test.mjs';
import { aggregate, gates, handoffReports } from './go-no-go.mjs';
import fs from 'node:fs';
function fixture() {
  return { NODE_ENV: 'production', NODE_VERSION: '22.23.2', KIDMAIS_DEPLOY_ENV: 'production', DATABASE_URL: 'postgresql://synthetic:FAKE_PASSWORD@database.example/kidmais_production', DATABASE_POOL_MAX: '10', DATABASE_CONNECTION_TIMEOUT_MS: '5000', DATABASE_IDLE_TIMEOUT_MS: '30000', DATABASE_SSL: 'true', DATABASE_SSL_REJECT_UNAUTHORIZED: 'true', FESTA_ENABLED: 'true', CONTRATO_ACEITE_DEV_ENABLED: 'false', ADMIN_AUTH_ORIGIN: 'https://admin.example', ADMIN_AUTH_SECRET: 'SYNTHETIC_ADMIN_VALUE_'.repeat(3), IDENTIDADE_OTP_PEPPER: 'SYNTHETIC_PEPPER_VALUE', WHATSAPP_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'), WHATSAPP_CREDENTIAL_KEY_VERSION: '1', META_APP_SECRET: 'SYNTHETIC_META_SECRET', WHATSAPP_CLOUD_ACCESS_TOKEN: 'SYNTHETIC_TOKEN' };
}
function internalFixture() {
  return { ...fixture(), DATABASE_URL: 'postgresql://synthetic:FAKE_PASSWORD@dpg-' + 'a'.repeat(20) + '-a/kidmais_production', DATABASE_SSL_REJECT_UNAUTHORIZED: 'false' };
}
function run(file, env, args = ['--json']) {
  return spawnSync(process.execPath, [path.join(import.meta.dirname, file + '.mjs'), ...args], { encoding: 'utf8', env: { ...env, SystemRoot: process.env.SystemRoot, PATH: process.env.PATH } });
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
    const env = fixture(); delete env[key]; assert.equal(envCheck.check(env).status, 'UNKNOWN', key);
  }
  for (const change of [{ KIDMAIS_STAGING_OTP_DISABLED: 'SIM' }, { DATABASE_SSL: 'false' }, { FESTA_ENABLED: 'false' }, { CONTRATO_ACEITE_DEV_ENABLED: 'true' }, { WHATSAPP_CREDENTIAL_ENCRYPTION_KEY: 'invalid' }]) assert.ok(envCheck.check({ ...fixture(), ...change }).blockers.length);
});
test('all CLI JSON and text outputs exclude synthetic secrets', () => {
  const env = fixture();
  for (const file of ['check-env', 'check-database-target', 'check-migrations', 'smoke-test', 'go-no-go']) {
    for (const args of [[], ['--json']]) {
      const r = run(file, env, args);
      assert.equal(r.stderr, '');
      if (args.length) assert.equal(JSON.parse(r.stdout).schemaVersion, 2);
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

test('staging Gupshup disabled by default or explicit gates accepts coherent degraded health', () => {
  const env = { ...fixture(), KIDMAIS_DEPLOY_ENV: 'staging', IDENTIDADE_OTP_PROVIDER: 'gupshup' };
  const body = { ...ready, status: 'degraded', components: { ...ready.components, otp: 'unavailable' }, otp: { provider: 'gupshup', configured: true, enabled: false, reason: 'staging_disabled' } };
  for (const gates of [{}, { GUPSHUP_OTP_ENABLED: 'false' }, { GUPSHUP_OTP_ENABLED: 'true', KIDMAIS_STAGING_OTP_DISABLED: 'SIM' }]) {
    const result = smoke.evaluate({ ...env, ...gates }, 200, body);
    assert.deepEqual(result.blockers, []);
    assert.ok(result.pending.includes('STAGING_OTP_DISABLED_EXPECTED'));
    assert.ok(result.pending.includes('HEALTH_DOES_NOT_PROVE_WHATSAPP_DELIVERY'));
    assert.equal(result.evidence[0].otpReady, false);
  }
});

test('staging Gupshup degraded requires blocked configuration and matching health metadata', () => {
  const env = { ...fixture(), KIDMAIS_DEPLOY_ENV: 'staging', IDENTIDADE_OTP_PROVIDER: 'gupshup', GUPSHUP_OTP_ENABLED: 'false' };
  const body = { ...ready, status: 'degraded', components: { ...ready.components, otp: 'unavailable' }, otp: { provider: 'gupshup', configured: true, enabled: false, reason: 'staging_disabled' } };
  for (const otp of [undefined, {}, { ...body.otp, provider: 'disabled' }, { ...body.otp, configured: false }, { ...body.otp, enabled: true }, { ...body.otp, reason: 'provider_failed' }]) {
    const result = smoke.evaluate(env, 200, { ...body, otp });
    assert.ok(result.blockers.includes('STAGING_DEGRADED_NOT_AUTHORIZED'));
    assert.ok(!result.pending.includes('STAGING_OTP_DISABLED_EXPECTED'));
  }
  for (const gates of [{ GUPSHUP_OTP_ENABLED: 'true' }, { GUPSHUP_OTP_ENABLED: '' }, { GUPSHUP_OTP_ENABLED: 'FALSE', KIDMAIS_STAGING_OTP_DISABLED: 'SIM' }]) {
    assert.ok(smoke.evaluate({ ...env, ...gates }, 200, body).blockers.includes('STAGING_DEGRADED_NOT_AUTHORIZED'));
  }
  const production = smoke.evaluate({ ...env, KIDMAIS_DEPLOY_ENV: 'production' }, 200, body);
  assert.ok(!production.pending.includes('STAGING_OTP_DISABLED_EXPECTED'));
  assert.ok(production.pending.includes('OTP_UNAVAILABLE'));
  assert.ok(smoke.evaluate(env, 503, body).blockers.includes('HEALTH_HTTP_NOT_200'));
});
test('database/festa failures and actual 503 block', () => {
  for (const name of ['database', 'festa']) assert.ok(smoke.evaluate(fixture(), 200, { ...ready, components: { ...ready.components, [name]: 'unavailable' } }).blockers.length);
  assert.ok(smoke.evaluate(fixture(), 503, { ok: false, status: 'unavailable' }).blockers.includes('HEALTH_HTTP_NOT_200'));
});
test('smoke mocked transport: GET, redirect refusal, invalid JSON, oversized body', async () => {
  const opts = { 'base-url': 'https://admin.example' };
  const r = await smoke.check(fixture(), opts, async (url, options) => { assert.equal(url.pathname, '/api/health'); assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error'); return new Response(JSON.stringify(ready)); });
  assert.deepEqual(r.blockers, []);
  for (const content of ['SYNTHETIC_TOKEN', 'x'.repeat(65537)]) assert.equal((await smoke.check(fixture(), opts, async () => new Response(content))).status, 'UNKNOWN');
  for (const url of ['http://admin.example', 'https://user:FAKE@admin.example', 'https://admin.example/?token=FAKE']) assert.equal((await smoke.check(fixture(), { 'base-url': url }, () => { throw new Error('must not fetch'); })).status, 'FAIL_VERIFIED');
});
test('inventory excludes rollback and never claims applied state', async () => {
  const r = await migrations.check({}); assert.deepEqual(r.blockers, []); assert.equal(r.evidence[0].appliedState, 'unknown'); assert.equal(r.evidence[0].latest, '20261006_066_pix_recebimento_empresa.sql'); assert.ok(!r.evidence[0].migrations.some(x => x.includes('999') || x.endsWith('_down.sql')));
  assert.deepEqual(r.evidence[0].migrations.filter(x => Number.parseInt(x.split('_')[1], 10) > 19), [
    '20260923_021_catalogo_configuravel_estrutura.sql', '20260923_022_catalogo_itens_iniciais.sql',
    '20260923_023_adicionais_por_pacote.sql', '20260923_024_taxa_rolha_versionada.sql', '20260923_025_extras_unitarios_pizza.sql',
    '20260925_026_perfil_empresa_estrutura.sql',
    '20260925_027_perfil_empresa_cadastro.sql',
    '20260925_028_perfil_empresa_revisao_aplicacao.sql',
    '20260926_029_fechamento_pacote_snapshot.sql',
    '20260926_030_preco_utilizado.sql',
    '20260926_031_empresas_comercial.sql',
    '20260926_032_pacote_revisao.sql',
    '20260926_033_tabela_preco_publicacao.sql',
    '20260926_034_integridade_tenant_comercial.sql',
    '20260926_035_publicacao_tabela_invariantes.sql',
    '20260926_036_empresa_pai_imutavel.sql',
    '20260926_037_publicacao_concorrencia.sql',
    '20260926_038_integridade_tenant_atomica.sql',
    '20260926_039_publicacao_serial_completa.sql',
    '20260926_040_integridade_sem_excecao_nominal.sql',
    '20260926_041_revisao_mesmo_tenant.sql',
    '20260926_042_reativacao_faixa_publicada.sql',
    '20260926_043_estrutura_tenant.sql',
    '20260926_044_ciclo_empresa.sql',
    '20260926_045_ciclo_membership.sql',
    '20260926_046_kidmais_legado_controlado.sql',
    '20260926_047_escopo_comercial_tabela.sql',
    '20260927_048_supersessao_tabela_publicada.sql',
    '20260927_049_publicacao_insert_e_trava.sql',
    '20260927_050_item_sem_categoria.sql',
    '20260927_051_snapshot_item_especifico.sql',
    '20260927_052_financeiro_gerencial.sql',
    '20260928_053_integridade_tenant_fechamento.sql',
    '20260928_054_empresa_id_clientes_fechamentos.sql',
    '20260928_055a_inteligencia_uso.sql',
    '20260928_055b_inteligencia_operacoes.sql',
    '20260928_055c_inteligencia_documentos.sql',
    '20260928_055d_inteligencia_importacoes.sql',
    '20260929_056_membership_papel_festa_tenant.sql',
    '20260929_057_assinatura_contrato_empresa.sql',
    '20260929_058_inteligencia_skills.sql',
    '20261001_059_operacional_parametros_consumo.sql',
    '20261002_061_contratos_importados_integracao.sql',
    '20261002_062_agenda_empresa_unidade.sql',
    '20261004_063_painel_desenvolvedor.sql',
    '20261006_064_reimportacao_apos_cancelamento.sql',
    '20261006_066_pix_recebimento_empresa.sql',
  ]);
  assert.deepEqual(r.evidence[0].deliberatelyAbsent, [{ id: '020', reason: 'FOUNDATION_SAAS_SEPARATE_BRANCH_NOT_REQUIRED_BY_CATALOG' }]);
  // 055a–d são reconhecidas, mas o inventário nunca afirma aplicação e marca a autorização explícita.
  assert.deepEqual(r.evidence[0].requiresExplicitAuthorization, ['20260928_055a_inteligencia_uso.sql', '20260928_055b_inteligencia_operacoes.sql', '20260928_055c_inteligencia_documentos.sql', '20260928_055d_inteligencia_importacoes.sql', '20260929_056_membership_papel_festa_tenant.sql', '20260929_057_assinatura_contrato_empresa.sql', '20260929_058_inteligencia_skills.sql', '20261001_059_operacional_parametros_consumo.sql', '20261002_061_contratos_importados_integracao.sql', '20261002_062_agenda_empresa_unidade.sql', '20261004_063_painel_desenvolvedor.sql', '20261006_064_reimportacao_apos_cancelamento.sql', '20261006_066_pix_recebimento_empresa.sql']);
  assert.ok(r.pending.includes('055A_D_NOT_APPLIED_REQUIRE_EXPLICIT_AUTHORIZATION'));
  assert.ok(r.pending.includes('056_NOT_APPLIED_REQUIRES_EXPLICIT_AUTHORIZATION'));
  assert.ok(r.pending.includes('057_NOT_APPLIED_REQUIRES_EXPLICIT_AUTHORIZATION'));
  assert.ok(r.pending.includes('058_NOT_APPLIED_REQUIRES_EXPLICIT_AUTHORIZATION'));
  assert.ok(r.pending.includes('059_NOT_APPLIED_REQUIRES_EXPLICIT_AUTHORIZATION'));
  assert.ok(r.pending.includes('061_NOT_APPLIED_REQUIRES_EXPLICIT_AUTHORIZATION'));
  assert.ok(r.pending.includes('062_NOT_APPLIED_REQUIRES_EXPLICIT_AUTHORIZATION'));
  assert.ok(r.pending.includes('063_NOT_APPLIED_REQUIRES_EXPLICIT_AUTHORIZATION'));
  assert.ok(r.pending.includes('064_NOT_APPLIED_REQUIRES_EXPLICIT_AUTHORIZATION'));
  assert.ok(r.pending.includes('066_NOT_APPLIED_REQUIRES_EXPLICIT_AUTHORIZATION'));
});

const root = path.resolve(import.meta.dirname, '../..');
test('D4: the inventory mirrors database/migrations exactly (only the 999 down excluded); every rollback stays out', () => {
  const dir = path.join(root, 'database/migrations');
  const repo = fs.readdirSync(dir).filter(x => x !== '20260907_999_crm_core_down.sql').sort();
  assert.deepEqual([...migrations.approvedFiles].sort(), repo, 'every legitimate up migration is recognized; nothing extra is approved');
  assert.ok(!migrations.approvedFiles.some(x => x.endsWith('_down.sql')), 'no *_down.sql is an up migration');
  for (const down of fs.readdirSync(path.join(root, 'database/rollback'))) {
    const r = migrations.inspectInventory([...repo, down], () => true);
    assert.ok(r.blockers.includes('MIGRATION_BASELINE_REVIEW_REQUIRED'), `${down}: a rollback placed with the migrations blocks`);
  }
  for (const unknown of ['20260928_055e_inteligencia_extra.sql', '20260928_055_inteligencia.sql', '20260929_056_future.sql', '20260929_057_future.sql', '20260930_058_future.sql', '20260928_055a_inteligencia_uso_down.sql']) {
    assert.ok(migrations.inspectInventory([...repo, unknown], () => true).blockers.includes('MIGRATION_BASELINE_REVIEW_REQUIRED'), unknown);
  }
  for (const file of repo) {
    const r = migrations.inspectInventory(repo.filter(x => x !== file), () => true);
    const id = file.split('_')[1];
    const esperado = id === '006a' ? 'MIGRATION_006A_MISSING' : 'MIGRATION_SEQUENCE_INVALID_' + (/^\d+$/.test(id) ? String(Number(id)) : id.replace(/^0+/, ''));
    assert.ok(r.blockers.includes(esperado), `${file}: missing blocks with a readable id`);
  }
});

test('D4: each migration requires its reviewed check files (inline-guarded 049–051 need none; 052/054/055a–d use their real names)', () => {
  const repo = migrations.approvedFiles;
  const expected = {
    '20260927_049_publicacao_insert_e_trava.sql': [], '20260927_050_item_sem_categoria.sql': [], '20260927_051_snapshot_item_especifico.sql': [],
    '20260927_052_financeiro_gerencial.sql': ['20260927_052_financeiro_precheck.sql', '20260927_052_financeiro_postcheck.sql'],
    '20260928_053_integridade_tenant_fechamento.sql': ['20260928_053_precheck.sql', '20260928_053_postcheck.sql'],
    '20260928_054_empresa_id_clientes_fechamentos.sql': ['20260928_054_precheck.sql', '20260928_054_backfill_imediato.sql', '20260928_054_postcheck.sql'],
    '20260928_055a_inteligencia_uso.sql': ['20260928_055a_postcheck.sql'], '20260928_055d_inteligencia_importacoes.sql': ['20260928_055d_postcheck.sql'],
    '20260929_056_membership_papel_festa_tenant.sql': ['20260929_056_precheck.sql', '20260929_056_postcheck.sql'],
    '20260929_057_assinatura_contrato_empresa.sql': ['20260929_057_precheck.sql', '20260929_057_postcheck.sql'],
    '20260929_058_inteligencia_skills.sql': ['20260929_058_postcheck.sql'],
    '20261001_059_operacional_parametros_consumo.sql': ['20261001_059_postcheck.sql'],
    '20261002_061_contratos_importados_integracao.sql': ['20261002_061_precheck.sql', '20261002_061_postcheck.sql'],
    '20261002_062_agenda_empresa_unidade.sql': ['20261002_062_precheck.sql', '20261002_062_postcheck.sql'],
    '20261004_063_painel_desenvolvedor.sql': ['20261004_063_precheck.sql', '20261004_063_postcheck.sql'],
    '20261006_064_reimportacao_apos_cancelamento.sql': ['20261006_064_precheck.sql', '20261006_064_postcheck.sql'],
    '20261006_066_pix_recebimento_empresa.sql': ['20261006_066_precheck.sql', '20261006_066_postcheck.sql'],
    '20260925_026_perfil_empresa_estrutura.sql': ['20260925_026_precheck.sql', '20260925_026_postcheck.sql'],
  };
  for (const [file, checks] of Object.entries(expected)) assert.deepEqual(migrations.requiredChecks(file), checks, file);
  for (const file of repo) {
    for (const check of migrations.requiredChecks(file)) {
      assert.ok(fs.existsSync(path.join(root, 'database/checks', check)), `${check} exists`);
      const r = migrations.inspectInventory(repo, name => name !== check);
      assert.deepEqual(r.blockers, ['CHECK_FILE_MISSING_' + check.slice(9, -4)], check);
    }
  }
});

test('V1 inventory rejects missing or duplicate approved migrations, including the legacy baseline', async () => {
  const files = (await migrations.check({})).evidence[0].migrations;
  assert.deepEqual(migrations.inspectInventory([...files, '20260907_999_crm_core_down.sql'], () => true).blockers, []);
  for (const file of files) {
    for (const entries of [files.filter(x => x !== file), [...files, file]]) {
      const r = migrations.inspectInventory(entries, () => true);
      assert.equal(r.status, 'FAIL_VERIFIED', file);
      assert.equal(r.evidence[0].appliedState, 'unknown');
    }
  }
});

test('V1 inventory refuses Foundation 020, later versions, variants and unrecognized files', async () => {
  const files = (await migrations.check({})).evidence[0].migrations;
  for (const unexpected of [
    '20260923_020_foundation.sql', '20260923_026_future.sql', '20260923_999_unexpected.sql',
    '20260923_021a_patch.sql', '20260923_019a_patch.sql', '20260924_025_extras_unitarios_pizza.sql',
    '20260923_025_renamed.sql', '20260923_026_future_down.sql', 'unexpected.sql', 'manual.SQL', 'nested-directory',
  ]) {
    const r = migrations.inspectInventory([...files, unexpected], () => true);
    assert.ok(r.blockers.includes('MIGRATION_BASELINE_REVIEW_REQUIRED'), unexpected);
    assert.equal(r.evidence[0].status, 'FAIL_VERIFIED');
  }
  const renamed = files.map(x => x.includes('_025_') ? '20260923_025_renamed.sql' : x);
  assert.ok(migrations.inspectInventory(renamed, () => true).blockers.includes('MIGRATION_SEQUENCE_INVALID_25'));
});

test('V1 catalog requires each precheck and postcheck without accessing a database', async () => {
  const files = (await migrations.check({})).evidence[0].migrations;
  for (let id = 21; id <= 25; id++) {
    for (const kind of ['precheck', 'postcheck']) {
      const missing = `20260923_0${id}_${kind}.sql`;
      const r = migrations.inspectInventory(files, name => name !== missing);
      assert.deepEqual(r.blockers, [`CHECK_FILE_MISSING_0${id}_${kind}`]);
      assert.equal(r.evidence[0].appliedState, 'unknown');
    }
  }
});
test('aggregator fails closed, distinguishes partial/commercial and stale reports', async () => {
  const binding = { environment: 'production', commit: 'synthetic-commit', origin: 'https://admin.example', database: 'kidmais_production' };
  const record = { ...binding, schemaVersion: 1, verifiedAt: new Date().toISOString(), ...Object.fromEntries(gates.map(x => [x, true])) };
  const results = [envCheck.check(fixture()), database.target(fixture()), await migrations.check({}), smoke.evaluate(fixture(), 200, ready)];
  assert.equal(aggregate(results, undefined, binding).decision, 'NO-GO');
  assert.equal(aggregate(results, record, binding).decision, 'GO-PARCIAL');
  assert.equal(aggregate(results, { ...record, whatsappDelivery: true }, binding).decision, 'GO');
  for (const change of [{ environment: 'staging' }, { migrationsThrough019: false }, { credentialRotation: false }, { verifiedAt: '2000-01-01T00:00:00Z' }, { commit: 'wrong' }]) assert.equal(aggregate(results, { ...record, ...change }, binding).decision, 'NO-GO');
});
test('missing local values are UNKNOWN and do not claim remote misconfiguration', async () => {
  for (const name of ['check-env', 'check-database-target']) {
    const output = run(name, {});
    const r = JSON.parse(output.stdout);
    assert.equal(output.status, 1);
    assert.equal(r.status, 'UNKNOWN');
    assert.deepEqual(r.blockers, []);
    assert.ok(r.unknown.includes('LOCAL:DATABASE_URL_NOT_AVAILABLE'));
    assert.equal(r.evidence[0].remoteState, 'not-verified');
  }
  const env = fixture(); delete env.DATABASE_URL;
  assert.equal((await database.check(env, { connect: true })).status, 'UNKNOWN');
  assert.equal(envCheck.check(env).status, 'UNKNOWN');
  const r = JSON.parse(run('go-no-go', {}).stdout);
  assert.equal(r.decision, 'NO-GO');
  assert.equal(r.status, 'UNKNOWN');
  assert.deepEqual(r.blockers, []);
  assert.ok(r.unknown.includes('smoke:OPERATIONAL:HEALTH_NOT_VERIFIED_NO_URL'));
});
test('proven staging target is FAIL_VERIFIED in local scope', () => {
  const env = { ...fixture(), DATABASE_URL: 'postgres://synthetic:FAKE@db.example/kidmais_staging' };
  const r = database.target(env);
  assert.equal(r.status, 'FAIL_VERIFIED');
  assert.ok(r.blockers.includes('LOCAL:DATABASE_TARGET_FORBIDDEN'));
  assert.equal(r.evidence[0].remoteState, 'not-verified');
  const combined = JSON.parse(run('go-no-go', env).stdout);
  assert.equal(combined.status, 'FAIL_VERIFIED');
  assert.equal(combined.decision, 'NO-GO');
});
test('handoff report is explicit, narrowly validated and never direct evidence', () => {
  const markdown = fs.readFileSync(path.join(import.meta.dirname, '../../docs/HANDOFF_V1_PRODUCAO.md'), 'utf8');
  const reports = handoffReports(markdown);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].status, 'PASS_REPORTED');
  assert.equal(reports[0].scope, 'OPERATIONAL');
  assert.equal(reports[0].directlyVerified, false);
  for (const invalid of ['', markdown + markdown, markdown.replace('"oldCredentialRevoked": true', '"oldCredentialRevoked": false'), markdown.replace('"sessionUser": "kidmais_production_app_v2"', '"sessionUser": "SYNTHETIC_SECRET"')]) assert.deepEqual(handoffReports(invalid), []);
  const output = JSON.parse(run('go-no-go', {}).stdout);
  assert.equal(output.reported[0].status, 'PASS_REPORTED');
  assert.equal(output.reported[0].directlyVerified, false);
  assert.equal(output.decision, 'NO-GO');
  assert.ok(output.unknown.some(x => x.endsWith('credentialRotation')));
  const withExtra = markdown.replace('"schemaVersion": 1,', '"secret": "SYNTHETIC_HIDDEN_VALUE", "schemaVersion": 1,');
  assert.ok(!JSON.stringify(handoffReports(withExtra)).includes('SYNTHETIC_HIDDEN_VALUE'));
});
test('reports cannot override unknowns, failures or omitted direct checks', async () => {
  const binding = { environment: 'production', commit: 'synthetic', origin: 'https://admin.example', database: 'kidmais_production' };
  const record = { ...binding, schemaVersion: 1, verifiedAt: new Date().toISOString(), ...Object.fromEntries(gates.map(x => [x, true])), whatsappDelivery: true };
  const results = [envCheck.check({}), database.target({}), await migrations.check({}), smoke.evaluate(fixture(), 200, ready)];
  const r = aggregate(results, record, binding);
  assert.equal(r.decision, 'NO-GO');
  assert.deepEqual(r.blockers, []);
  assert.ok(r.reported.every(x => x.status === 'PASS_REPORTED' && x.directlyVerified === false));
  assert.equal(aggregate([smoke.evaluate(fixture(), 200, ready)], record, binding).decision, 'NO-GO');
});
test('optional connection uses read-only session and fixed SELECTs through fake pg', async () => {
  const queries = []; let ended = false;
  class FakeClient {
    constructor(config) { assert.ok(config.options.includes('default_transaction_read_only=on')); assert.equal(config.ssl.rejectUnauthorized, true); }
    on() {}
    async connect() {}
    async query(sql) { queries.push(sql); return { rows: sql.includes('current_database()') ? [{ database: 'kidmais_production' }] : [{ count: 63 }] }; }
    async end() { ended = true; }
  }
  assert.deepEqual((await database.check(fixture(), { connect: true }, async () => ({ Client: FakeClient }))).blockers, []);
  assert.equal(queries.length, 2); assert.ok(queries.every(x => x.startsWith('SELECT '))); assert.equal(ended, true);
});

test('ES module imports do not execute the CLI', () => {
  const urls = ['check-env', 'check-database-target', 'check-migrations', 'smoke-test', 'go-no-go'].map(name => new URL('./' + name + '.mjs', import.meta.url).href);
  const output = spawnSync(process.execPath, ['--input-type=module', '--eval', `await Promise.all(${JSON.stringify(urls)}.map(url => import(url)));`], { encoding: 'utf8', env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH } });
  assert.equal(output.status, 0);
  assert.equal(output.stdout, '');
  assert.equal(output.stderr, '');
});

test('default checks and refused targets never load pg or fetch', async () => {
  let pgLoads = 0; let requests = 0;
  const loadPg = async () => { pgLoads++; throw new Error('Unexpected pg load'); };
  const fetcher = async () => { requests++; throw new Error('Unexpected request'); };
  assert.equal((await database.check(fixture(), {}, loadPg)).status, 'PASS');
  assert.equal((await database.check({}, { connect: true }, loadPg)).status, 'UNKNOWN');
  const forbidden = { ...fixture(), DATABASE_URL: 'postgres://synthetic:FAKE@db.example/kidmais_staging' };
  assert.equal((await database.check(forbidden, { connect: true }, loadPg)).status, 'FAIL_VERIFIED');
  await assert.rejects(database.readDatabase({ ...fixture(), DATABASE_SSL: 'false' }, 'SELECT 1', loadPg), /TLS_REQUIRED/);
  assert.equal((await smoke.check(fixture(), {}, fetcher)).status, 'UNKNOWN');
  assert.equal(pgLoads, 0);
  assert.equal(requests, 0);
});

test('production internal Render TLS accepts self-signed certificate without claiming remote verification', () => {
  const env = internalFixture();
  const target = database.target(env);
  assert.equal(target.connectionType, 'RENDER_INTERNAL');
  assert.equal(target.status, 'PASS');
  const checked = envCheck.check(env);
  assert.equal(checked.status, 'PASS');
  assert.ok(!checked.blockers.some(x => x.includes('PRODUCTION_TLS_REQUIRED')));
  assert.ok(checked.evidence.some(x => x.validation === 'tls-policy' && x.remoteState === 'not-verified'));
  const output = run('check-env', env);
  assert.equal(output.status, 0);
  assert.equal(JSON.parse(output.stdout).status, 'PASS');
  const aggregate = JSON.parse(run('go-no-go', env).stdout);
  assert.equal(aggregate.blockers.length, 0);
  assert.equal(aggregate.decision, 'NO-GO'); // The TLS exception supplies no missing operational evidence.
});

test('production TLS cannot be disabled, including on an internal endpoint', async () => {
  let loaded = false;
  for (const env of [fixture(), internalFixture()]) {
    env.DATABASE_SSL = 'false';
    const checked = envCheck.check(env);
    assert.equal(checked.status, 'FAIL_VERIFIED');
    assert.ok(checked.blockers.includes('LOCAL:PRODUCTION_TLS_REQUIRED'));
    await assert.rejects(database.readDatabase(env, 'SELECT 1', async () => { loaded = true; }), /TLS_REQUIRED/);
  }
  assert.equal(loaded, false);
});

test('external and unrecognized endpoints never get the internal TLS exception', async () => {
  const internal = 'dpg-' + 'a'.repeat(20) + '-a';
  for (const host of ['database.example', internal + '.oregon-postgres.render.com', internal + '.attacker.example', internal + '.', 'prefix-' + internal, 'dpg-short-a', 'unknownhost']) {
    const env = { ...internalFixture(), DATABASE_URL: 'postgres://synthetic:FAKE_PASSWORD@' + host + '/kidmais_production' };
    const checked = envCheck.check(env);
    assert.ok(['FAIL_VERIFIED', 'UNKNOWN'].includes(checked.status));
    let loaded = false;
    await assert.rejects(database.readDatabase(env, 'SELECT 1', async () => { loaded = true; }), /TLS_REQUIRED/);
    assert.equal(loaded, false);
  }
  const missing = internalFixture(); delete missing.DATABASE_URL;
  assert.equal(database.target(missing).connectionType, 'UNKNOWN');
  const checked = envCheck.check(missing);
  assert.equal(checked.status, 'UNKNOWN');
  assert.ok(checked.unknown.includes('LOCAL:TLS_INTERNAL_DESTINATION_NOT_VERIFIED'));
  for (const name of ['kidmais_manager', 'kidmais_staging']) {
    const forbidden = { ...internalFixture(), DATABASE_URL: internalFixture().DATABASE_URL.replace('kidmais_production', name) };
    assert.equal(envCheck.check(forbidden).status, 'FAIL_VERIFIED');
    assert.equal(database.allowsInternalTls(forbidden, database.target(forbidden)), false);
  }
});

test('optional internal connection keeps TLS and read-only protections through fake pg', async () => {
  let loaded = 0; let ended = false;
  const queries = [];
  class FakeClient {
    constructor(config) {
      assert.deepEqual(config.ssl, { rejectUnauthorized: false });
      assert.ok(config.options.includes('default_transaction_read_only=on'));
      assert.ok(config.options.includes('statement_timeout=5000'));
    }
    on() {}
    async connect() {}
    async query(sql) { queries.push(sql); return { rows: sql.includes('current_database()') ? [{ database: 'kidmais_production' }] : [{ count: 0 }] }; }
    async end() { ended = true; }
  }
  const loadPg = async () => { loaded++; return { Client: FakeClient }; };
  assert.equal((await database.check(internalFixture(), {}, loadPg)).status, 'PASS');
  assert.equal(loaded, 0);
  assert.equal((await database.check(internalFixture(), { connect: true }, loadPg)).status, 'PASS');
  assert.equal(loaded, 1);
  assert.equal(queries.length, 2);
  assert.ok(queries.every(sql => sql.startsWith('SELECT ')));
  assert.equal(ended, true);
});

test('TLS classification never exposes URL, hostname or secrets in text or JSON', () => {
  for (const env of [internalFixture(), { ...fixture(), DATABASE_SSL_REJECT_UNAUTHORIZED: 'false' }]) {
    for (const script of ['check-env', 'check-database-target', 'go-no-go']) {
      for (const args of [[], ['--json']]) {
        const output = run(script, env, args);
        assert.equal(output.stderr, '');
        if (args.length) assert.equal(JSON.parse(output.stdout).schemaVersion, 2);
        for (const secret of [env.DATABASE_URL, new URL(env.DATABASE_URL).hostname, 'FAKE_PASSWORD', env.ADMIN_AUTH_SECRET, env.IDENTIDADE_OTP_PEPPER, env.WHATSAPP_CREDENTIAL_ENCRYPTION_KEY, env.META_APP_SECRET, env.WHATSAPP_CLOUD_ACCESS_TOKEN]) assert.ok(!output.stdout.includes(secret));
      }
    }
  }
});
