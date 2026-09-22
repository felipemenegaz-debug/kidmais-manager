'use strict';

const { refuse, TARGET } = require('./sanitize-v1-post-019/guards.cjs');
const { assertPolicy, assertSealed } = require('./sanitize-v1-post-019/checks.cjs');
const { manifests } = require('./sanitize-v1-post-019.cjs');

const futureCases = Object.freeze([
  'REFUSE_BOTH_PROTECTED_DATABASES_BEFORE_CONNECT', 'CANONICAL_001_019_DISPOSABLE_REPLAY',
  'REVIEW_NATIVE_PROJECTION_NOT_LEARNED_FROM_SANITIZATION_TARGET', 'NATIVE_CATALOG_MATCHES_STATIC_DERIVATION',
  'DRY_RUN_UNCHANGED', 'ALL_OPERATIONAL_DOMAINS_SYNTHETIC', 'ONE_TRUNCATE_54',
  'CATALOG_BYTE_PRESERVATION', 'POST019_INVARIANTS', 'UNKNOWN_TABLE_COLUMN_REFUSED',
  'EXTERNAL_FK_REFUSED', 'SCHEMA_CATALOG_DRIFT_REFUSED', 'ROLLBACK_ON_INJECTED_FAILURE',
  'LOCK_TIMEOUT_CONCURRENCY', 'IDEMPOTENT_EMPTY_OUTPUT', 'COMMIT_DISCONNECT_UNKNOWN',
  'ATTESTATION_FAILURE_AFTER_COMMIT', 'NO_SENSITIVE_LOGS', 'EMPTY_54_POSTCHECK',
]);
function readiness() {
  assertPolicy(manifests.policy);
  let sealed = false;
  try { assertSealed(manifests.schema); sealed = true; } catch { /* Fail closed when the versioned seal is absent or altered. */ }
  return { target: TARGET, cases: futureCases, sealed, databaseAccessEnabled: false };
}
function run() { refuse('INTEGRATION_NOT_AUTHORIZED'); }
if (require.main === module) { process.stderr.write('INTEGRATION_NOT_AUTHORIZED\n'); process.exitCode = 1; }
module.exports = { readiness, futureCases, run };
