'use strict';

// Narrow physical R1 probe, never a general sanitizer entrypoint.
const { manifests } = require('./sanitize-v1-post-019.cjs');
const { TARGET } = require('./sanitize-v1-post-019/guards.cjs');
const { execute } = require('./sanitize-v1-post-019/transaction.cjs');

async function main(scenario) {
  if (!['rollback', 'commit', 'sql-error'].includes(scenario)) throw new Error('R1_SCENARIO_REFUSED');
  const plan = await execute({ mode: 'dry-run', target: TARGET }, manifests);
  if (plan.status !== 'PLAN' || !plan.rollbackConfirmed || plan.transactionOutcome !== 'ROLLED_BACK') throw new Error('R1_DRY_RUN_FAILED');
  const hooks = scenario === 'rollback' ? { beforeCommit() { throw Object.assign(new Error('R1_INJECTED_FAILURE'), { code: 'PROCESS_FAILED' }); } } :
    scenario === 'sql-error' ? { async beforeTruncate(session) { await session.command('SELECT 1/0;'); } } : {};
  const applied = await execute({ mode: 'apply', target: TARGET, authorized: true, planDigest: plan.plan.digest }, manifests, { hooks });
  if (scenario !== 'commit') {
    if (applied.status !== 'FAIL' || applied.stage !== (scenario === 'rollback' ? 'POSTCHECK' : 'LOCKED_SNAPSHOT') || !applied.rollbackConfirmed ||
        applied.transactionOutcome !== 'ROLLED_BACK' || applied.commitConfirmed) throw new Error('R1_ROLLBACK_UNPROVEN');
    if (scenario === 'sql-error' && (applied.code !== 'SQL_FAILED' || applied.sqlstate !== '22012')) throw new Error('R1_SQLSTATE_UNPROVEN');
  } else if (applied.status !== 'PASS' || !applied.commitConfirmed || applied.transactionOutcome !== 'COMMITTED') throw new Error('R1_COMMIT_UNPROVEN');
  const verified = scenario === 'commit' ? await execute({ mode: 'verify', target: TARGET }, manifests) : null;
  if (scenario === 'commit' && (verified.status !== 'PASS' || !verified.rollbackConfirmed || verified.transactionOutcome !== 'ROLLED_BACK')) throw new Error('R1_VERIFY_FAILED');
  process.stdout.write(JSON.stringify({ scenario, dry_run: plan.status, apply: applied.status,
    apply_stage: applied.stage || null, transaction_outcome: applied.transactionOutcome,
    rollback_confirmed: applied.rollbackConfirmed, commit_confirmed: applied.commitConfirmed,
    verify: verified?.status || null, plan_digest: plan.plan.digest }) + '\n');
}
if (require.main === module) main(process.argv[2]).catch(() => { process.stderr.write('R1_PROBE_FAILED\n'); process.exitCode = 1; });
