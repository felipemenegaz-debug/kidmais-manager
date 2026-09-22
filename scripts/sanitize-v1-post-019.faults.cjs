'use strict';

// Physical B5B-2B fault probe. Exact target is compiled into TARGET; no CLI coordinates.
const { manifests } = require('./sanitize-v1-post-019.cjs');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { TARGET, PSQL, nativeEnvironment, refuse } = require('./sanitize-v1-post-019/guards.cjs');
const { execute, snapshot } = require('./sanitize-v1-post-019/transaction.cjs');
const { publish } = require('./sanitize-v1-post-019/attestation.cjs');

const cases = new Set(['before-truncate', 'after-locks', 'after-truncate', 'postcheck', 'sql-error', 'timeout', 'concurrency', 'publication']);
function injected() { refuse('POSTCHECK_FAILED'); }
async function blockingReadLock() {
  const marker = `BLOCKER_READY_${randomBytes(16).toString('hex')}`;
  const child = spawn(PSQL, ['-X', '-w', '-A', '-t', '-v', 'ON_ERROR_STOP=1',
    '-h', TARGET.host, '-p', String(TARGET.port), '-U', 'postgres',
    '-d', `host=${TARGET.host} hostaddr=${TARGET.host} port=${TARGET.port} user=postgres dbname=${TARGET.database} sslmode=disable gssencmode=disable connect_timeout=5`],
  { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: nativeEnvironment(process.env) });
  child.stderr.on('data', () => {});
  try {
    await new Promise((resolve, reject) => {
      let buffer = '';
      const timer = setTimeout(() => reject(new Error('BLOCKER_TIMEOUT')), 10000);
      child.stdout.on('data', chunk => {
        buffer += String(chunk);
        if (buffer.length > 1024) { clearTimeout(timer); reject(new Error('BLOCKER_PROTOCOL_FAILED')); return; }
        if (buffer.includes(marker)) { clearTimeout(timer); resolve(); }
      });
      child.on('error', () => { clearTimeout(timer); reject(new Error('BLOCKER_PROCESS_FAILED')); });
      child.on('close', () => { clearTimeout(timer); reject(new Error('BLOCKER_PROCESS_FAILED')); });
      child.stdin.write(`BEGIN TRANSACTION READ ONLY;\nLOCK TABLE public.limites_autenticacao IN ACCESS SHARE MODE;\n\\echo ${marker}\n`);
    });
    return child;
  } catch (error) { child.kill(); throw error; }
}
async function main(which) {
  if (!cases.has(which)) throw new Error('FAULT_CASE_REFUSED');
  const dry = await execute({ mode: 'dry-run', target: TARGET }, manifests);
  if (dry.status !== 'PLAN' || !dry.rollbackConfirmed) throw new Error('FAULT_DRY_RUN_FAILED');
  const hooks = {};
  if (which === 'before-truncate') hooks.beforeTruncate = injected;
  if (which === 'after-locks') hooks.afterLocks = injected;
  if (which === 'after-truncate') hooks.afterTruncate = injected;
  if (which === 'sql-error') hooks.beforeTruncate = async session => { await session.command('SELECT 1/0;'); };
  if (which === 'timeout') hooks.beforeTruncate = async session => {
    await session.command('SET LOCAL statement_timeout = 100;');
    await session.command('SELECT pg_sleep(1);');
  };
  const dependencies = { hooks };
  if (which === 'postcheck') {
    let calls = 0;
    dependencies.readSnapshot = async (session, source, post) => {
      const actual = await snapshot(session, source, post);
      if (++calls === 3) actual.counts.clientes = 1;
      return actual;
    };
  }
  const blocker = which === 'concurrency' ? await blockingReadLock() : null;
  let applied;
  try { applied = await execute({ mode: 'apply', target: TARGET, authorized: true, planDigest: dry.plan.digest }, manifests, dependencies); }
  finally { if (blocker) { blocker.stdin.write('ROLLBACK;\n'); blocker.stdin.end(); blocker.kill(); } }
  if (which === 'publication') {
    if (applied.status !== 'PASS' || !applied.commitConfirmed) throw new Error('FAULT_COMMIT_FAILED');
    const now = new Date().toISOString();
    const published = await publish(applied, { mode: 'apply', target: TARGET }, manifests,
      { startedAt: now, completedAt: now }, async () => { throw new Error('SYNTHETIC_OUTPUT_FAILURE'); });
    if (published.result !== 'COMMIT_CONFIRMED_ATTESTATION_FAILED') throw new Error('FAULT_PUBLICATION_CLASSIFICATION_FAILED');
    const verified = await execute({ mode: 'verify', target: TARGET }, manifests);
    if (verified.status !== 'PASS') throw new Error('FAULT_PUBLICATION_VERIFY_FAILED');
    process.stdout.write(JSON.stringify({ case: which, dry_run: dry.status, apply: applied.status,
      publication: published.result, transaction_outcome: applied.transactionOutcome,
      commit_confirmed: applied.commitConfirmed, verify: verified.status }) + '\n');
    return;
  }
  const expectedStage = {
    'before-truncate': 'LOCKED_SNAPSHOT', 'after-locks': 'TABLE_LOCKS',
    'after-truncate': 'TRUNCATE', postcheck: 'POSTCHECK',
    'sql-error': 'LOCKED_SNAPSHOT', timeout: 'LOCKED_SNAPSHOT', concurrency: 'TABLE_LOCKS',
  }[which];
  if (applied.status !== 'FAIL' || applied.stage !== expectedStage ||
      applied.transactionOutcome !== 'ROLLED_BACK' || !applied.rollbackConfirmed || applied.commitConfirmed) throw new Error('FAULT_ROLLBACK_UNPROVEN');
  if (which === 'sql-error' && (applied.code !== 'SQL_FAILED' || applied.sqlstate !== '22012')) throw new Error('FAULT_SQLSTATE_UNPROVEN');
  if (which === 'timeout' && (applied.code !== 'SQL_FAILED' || applied.sqlstate !== '57014')) throw new Error('FAULT_TIMEOUT_UNPROVEN');
  if (which === 'concurrency' && (applied.code !== 'SQL_FAILED' || applied.sqlstate !== '55P03')) throw new Error('FAULT_CONCURRENCY_UNPROVEN');
  process.stdout.write(JSON.stringify({ case: which, dry_run: dry.status, apply: applied.status,
    stage: applied.stage, code: applied.code, sqlstate: applied.sqlstate,
    transaction_outcome: applied.transactionOutcome, rollback_confirmed: applied.rollbackConfirmed }) + '\n');
}
if (require.main === module) main(process.argv[2]).catch(() => { process.stderr.write('FAULT_PROBE_FAILED\n'); process.exitCode = 1; });
