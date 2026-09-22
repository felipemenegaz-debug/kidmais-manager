'use strict';

const { PROFILE, TARGET, hash, stable, refuse, safeCode } = require('./guards.cjs');
const { SOURCE_COMMIT, MIGRATION_019 } = require('./checks.cjs');
const schema = require('../../docs/baseline/V1-POST-019-SANITIZATION.schema.json');

// Deliberately restricted JSON Schema subset; unknown schema keywords fail closed.
function validateNode(value, rule) {
  const supported = ['$schema', '$id', 'title', 'description', 'type', 'const', 'enum', 'pattern',
    'minimum', 'maximum', 'properties', 'required', 'additionalProperties', 'items', 'minItems', 'maxItems'];
  if (Object.keys(rule).some(k => !supported.includes(k))) refuse('ATTESTATION_INVALID');
  if (Object.hasOwn(rule, 'const') && stable(value) !== stable(rule.const)) refuse('ATTESTATION_INVALID');
  if (rule.enum && !rule.enum.some(item => stable(item) === stable(value))) refuse('ATTESTATION_INVALID');
  if (rule.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) refuse('ATTESTATION_INVALID');
    if (rule.additionalProperties !== false || Object.keys(value).some(k => !Object.hasOwn(rule.properties, k)) ||
        rule.required.some(k => !Object.hasOwn(value, k))) refuse('ATTESTATION_INVALID');
    for (const [key, item] of Object.entries(value)) validateNode(item, rule.properties[key]);
  } else if (rule.type === 'array') {
    if (!Array.isArray(value) || value.length < rule.minItems || value.length > rule.maxItems) refuse('ATTESTATION_INVALID');
    value.forEach(item => validateNode(item, rule.items));
  } else if (rule.type === 'integer') {
    if (!Number.isSafeInteger(value) || value < rule.minimum || (rule.maximum !== undefined && value > rule.maximum)) refuse('ATTESTATION_INVALID');
  } else if (rule.type === 'string') {
    if (typeof value !== 'string' || (rule.pattern && !(new RegExp(rule.pattern)).test(value))) refuse('ATTESTATION_INVALID');
  } else if (rule.type === 'boolean') {
    if (typeof value !== 'boolean') refuse('ATTESTATION_INVALID');
  } else refuse('ATTESTATION_INVALID');
}
function validateAttestation(value) {
  validateNode(value, schema);
  if (value.result === 'PASS' && (value.mode === 'dry-run' || !value.counts || !value.plan_digest || value.code ||
      value.operational_rows_after !== 0 || (value.mode === 'apply' && !value.commit_confirmed) ||
      (value.mode === 'apply' && value.rollback_confirmed) ||
      (value.mode === 'verify' && (!value.rollback_confirmed || value.commit_confirmed)))) refuse('ATTESTATION_INVALID');
  if (value.result !== 'PASS' && (value.counts || Object.hasOwn(value, 'operational_rows_after'))) refuse('ATTESTATION_INVALID');
  if (value.result === 'PLAN' && (value.mode !== 'dry-run' || value.commit_confirmed || !value.rollback_confirmed || !value.plan_digest || value.code)) refuse('ATTESTATION_INVALID');
  if (value.result === 'FAIL' && (value.commit_confirmed || !value.code)) refuse('ATTESTATION_INVALID');
  if (value.result === 'COMMIT_UNKNOWN' && (value.mode !== 'apply' || value.commit_confirmed || value.rollback_confirmed || !value.code)) refuse('ATTESTATION_INVALID');
  if (value.result === 'COMMIT_CONFIRMED_ATTESTATION_FAILED' && (value.mode !== 'apply' || !value.commit_confirmed || value.rollback_confirmed || !value.code)) refuse('ATTESTATION_INVALID');
  if (value.commit_confirmed !== (value.transaction_outcome === 'COMMITTED') ||
      value.rollback_confirmed !== (value.transaction_outcome === 'ROLLED_BACK') ||
      (value.result === 'COMMIT_UNKNOWN' && value.transaction_outcome !== 'COMMIT_OUTCOME_UNKNOWN')) refuse('ATTESTATION_INVALID');
  if (value.sequences_preserved !== (value.result === 'PASS' && value.mode === 'apply') || value.identities_restarted !== false) refuse('ATTESTATION_INVALID');
  return value;
}
function attest(outcome, options, manifests, times) {
  const result = outcome.status;
  const value = { schema_version: 1, profile: PROFILE, result, mode: options.mode,
    source_commit: SOURCE_COMMIT, migration_019_sha256: MIGRATION_019,
    policy_sha256: hash(stable(manifests.policy)), expected_schema_sha256: hash(stable(manifests.schema)),
    canonical_catalog_sha256: hash(stable(manifests.catalog)), target: { ...TARGET },
    physical_fingerprint_sha256: manifests.schema.physical_projection.sha256,
    physical_components_digest_sha256: hash(stable(manifests.schema.physical_projection.component_sha256)),
    reference_recipe_sha256: manifests.schema.physical_projection.reference_recipe_sha256,
    reference_executor_sha256: manifests.schema.physical_projection.reference_executor_sha256,
    table_count: 63, empty_table_count: 54, canonical_table_count: 9,
    sequences_preserved: result === 'PASS' && options.mode === 'apply', identities_restarted: false,
    started_at: times.startedAt, completed_at: times.completedAt,
    commit_confirmed: outcome.commitConfirmed === true, rollback_confirmed: outcome.rollbackConfirmed === true,
    transaction_outcome: outcome.transactionOutcome,
    limitations: ['LOGICAL_STATE_ONLY', 'NOT_SECURE_ERASURE', 'NOT_MULTI_TENANT_CERTIFICATION', 'POINT_IN_TIME', 'IDENTITIES_NOT_RESTARTED'] };
  if (outcome.code) value.code = safeCode(outcome);
  if (outcome.plan) value.plan_digest = outcome.plan.digest;
  if (result === 'PASS') {
    value.counts = outcome.counts;
    value.operational_rows_after = Object.entries(manifests.policy.tables).filter(([, rule]) => rule === 'EMPTY').reduce((total, [table]) => total + outcome.counts[table], 0);
  }
  return validateAttestation(value);
}
async function publish(outcome, options, manifests, times, writer) {
  try {
    const value = attest(outcome, options, manifests, times);
    await writer(`${JSON.stringify(value)}\n`);
    return value;
  } catch {
    // The caller may report this fixed status through a separate safe channel. Never retry apply.
    return { result: outcome.status === 'COMMIT_UNKNOWN' ? 'COMMIT_UNKNOWN' : outcome.commitConfirmed ? 'COMMIT_CONFIRMED_ATTESTATION_FAILED' : 'FAIL',
      code: 'ATTESTATION_INVALID', commit_confirmed: outcome.commitConfirmed === true };
  }
}
module.exports = { validateNode, validateAttestation, attest, publish };
