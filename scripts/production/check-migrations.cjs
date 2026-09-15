'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { result, cli } = require('./common.cjs');
const { readDatabase } = require('./check-database-target.cjs');
async function check(env, options = {}) {
  const r = result('migrations');
  const root = path.resolve(__dirname, '../..');
  const files = fs.readdirSync(path.join(root, 'database/migrations')).filter(x => /^\d{8}_\d{3}[a-z]?_[a-z0-9_]+\.sql$/.test(x) && !x.endsWith('_down.sql')).sort();
  const ids = files.map(x => x.split('_')[1]);
  if (ids.filter(x => x === '006a').length !== 1) r.blockers.push('MIGRATION_006A_MISSING');
  if (!fs.existsSync(path.join(root, 'database/checks/20260908_011_pagamentos_postcheck.sql'))) r.blockers.push('CHECK_FILE_MISSING_011_postcheck');
  for (let n = 1; n <= 18; n++) if (ids.filter(x => x === String(n).padStart(3, '0')).length !== 1) r.blockers.push('MIGRATION_SEQUENCE_INVALID_' + n);
  if (ids.some(x => parseInt(x, 10) > 18)) r.blockers.push('MIGRATION_BASELINE_REVIEW_REQUIRED');
  for (const file of files.filter(x => Number(x.split('_')[1]) >= 13)) {
    for (const kind of ['precheck', 'postcheck']) if (!fs.existsSync(path.join(root, 'database/checks', file.slice(0, 12) + '_' + kind + '.sql'))) r.blockers.push('CHECK_FILE_MISSING_' + file.slice(9, 12) + '_' + kind);
  }
  r.evidence.push({ source: 'code', scope: 'REPOSITORY', status: 'PASS', migrations: files, latest: files.at(-1), appliedState: 'unknown' });
  r.pending.push('014_OLD_POSTCHECK_CAN_FALSE_NEGATIVE_ON_EVOLVED_SCHEMA');
  if (options['inspect-db']) {
    try { const data = await readDatabase(env, "SELECT count(*)::int AS count FROM pg_tables WHERE schemaname='public'"); r.evidence.push({ source: 'script', publicTables: Number(data.rows[0].count), appliedState: 'unknown' }); }
    catch { r.unknown.push('OPERATIONAL:MIGRATION_INSPECTION_NOT_VERIFIED'); }
  }
  return r;
}
if (require.main === module) cli('migrations', { 'inspect-db': 'boolean' }, check);
module.exports = { check };
