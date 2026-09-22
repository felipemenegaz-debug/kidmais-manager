'use strict';

const { parseArgs, safeCode } = require('./sanitize-v1-post-019/guards.cjs');
const { assertManifests, assertSealed } = require('./sanitize-v1-post-019/checks.cjs');
const { execute } = require('./sanitize-v1-post-019/transaction.cjs');
const { publish } = require('./sanitize-v1-post-019/attestation.cjs');
const manifests = Object.freeze({ policy: require('./sanitize-v1-post-019/policy.json'),
  schema: require('./sanitize-v1-post-019/expected-schema.json'),
  catalog: require('./sanitize-v1-post-019/canonical-catalog.json') });

async function main(argv, { run = execute, write = data => new Promise((resolve, reject) => {
  process.stdout.write(data, error => error ? reject(error) : resolve());
}), diagnostic = code => process.stderr.write(`${code}\n`) } = {}) {
  const startedAt = new Date().toISOString();
  try {
    const options = parseArgs(argv);
    assertManifests(manifests);
    // B5B-2A seal is versioned; tampering with projection/recipe blocks before psql.
    assertSealed(manifests.schema);
    const outcome = await run({ ...options, authorized: options.mode === 'apply' }, manifests);
    if (outcome.status === 'FAIL' && outcome.stage) diagnostic(`FAIL_STAGE_${outcome.stage}`);
    if (outcome.status === 'FAIL' && outcome.sqlstate) diagnostic(`FAIL_SQLSTATE_${outcome.sqlstate}`);
    const value = await publish(outcome, options, manifests,
      { startedAt, completedAt: new Date().toISOString() }, write);
    if (['COMMIT_UNKNOWN', 'COMMIT_CONFIRMED_ATTESTATION_FAILED'].includes(value.result)) diagnostic(value.result);
    return ['PASS', 'PLAN'].includes(value.result) ? 0 : 1;
  } catch (error) { diagnostic(safeCode(error)); return 1; }
}
if (require.main === module) main(process.argv.slice(2)).then(code => { process.exitCode = code; }, () => { process.exitCode = 1; });
module.exports = { main, manifests };
