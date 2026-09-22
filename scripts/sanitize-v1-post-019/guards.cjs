'use strict';

const { createHash } = require('node:crypto');

const TARGET = Object.freeze({ host: '127.0.0.1', port: 55429,
  database: 'kidmais_sanitize_v1_post019_b5b', user: 'kidmais_b5b_sanitizer' });
const PSQL = 'C:\\Program Files\\PostgreSQL\\18\\bin\\psql.exe';
const PROFILE = 'V1_POST019_EMPTY_OPERATION';
const CODES = Object.freeze(['INVALID_ARGUMENT', 'TARGET_REFUSED', 'AUTHORIZATION_REQUIRED',
  'DIGEST_MISMATCH', 'POLICY_INVALID', 'SCHEMA_MISMATCH', 'CATALOG_MISMATCH',
  'INVENTORY_MISMATCH', 'STRUCTURE_MISMATCH',
  'BASELINE_UNSEALED', 'PREFLIGHT_FAILED', 'POSTCHECK_FAILED', 'PROCESS_FAILED', 'SQL_FAILED',
  'PROTOCOL_FAILED', 'MANIFEST_INVALID', 'SOURCE_MISMATCH', 'FIXTURE_REFUSED',
  'INTEGRATION_NOT_AUTHORIZED', 'ATTESTATION_INVALID']);
function refuse(code) { throw Object.assign(new Error(CODES.includes(code) ? code : 'PROCESS_FAILED'), { code }); }
function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
function exactKeys(value, keys, code = 'MANIFEST_INVALID') {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join('|') !== [...keys].sort().join('|')) refuse(code);
}
function guardTarget(target) {
  exactKeys(target, Object.keys(TARGET), 'TARGET_REFUSED');
  if (target.database === 'kidmais_manager' || target.database === 'kidmais_v1_homologacao' ||
      stable(target) !== stable(TARGET)) refuse('TARGET_REFUSED');
  return target;
}
function parseArgs(argv) {
  let mode = 'dry-run';
  const values = {};
  const seen = new Set();
  const valueFlags = ['host', 'port', 'database', 'user', 'authorize-target', 'plan-digest'];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (['--dry-run', '--apply', '--verify'].includes(arg)) {
      if (seen.has('mode')) refuse('INVALID_ARGUMENT');
      seen.add('mode'); mode = arg.slice(2); continue;
    }
    const key = typeof arg === 'string' && arg.startsWith('--') ? arg.slice(2) : '';
    if (!valueFlags.includes(key) || seen.has(key) || typeof argv[i + 1] !== 'string' || argv[i + 1].startsWith('--')) refuse('INVALID_ARGUMENT');
    seen.add(key); values[key] = argv[++i];
  }
  // Explicit coordinates are mandatory: the allowlist is not a connection fallback.
  for (const key of ['host', 'port', 'database', 'user']) if (!seen.has(key)) refuse('INVALID_ARGUMENT');
  if (values.port !== String(TARGET.port)) refuse('TARGET_REFUSED');
  const target = guardTarget({ host: values.host, port: Number(values.port), database: values.database, user: values.user });
  const authorization = `${target.host}:${target.port}/${target.database}`;
  if (mode === 'apply' && values['authorize-target'] !== authorization) refuse('AUTHORIZATION_REQUIRED');
  if (mode === 'apply' && !/^[a-f0-9]{64}$/.test(values['plan-digest'] || '')) refuse('DIGEST_MISMATCH');
  if (mode !== 'apply' && (seen.has('authorize-target') || seen.has('plan-digest'))) refuse('INVALID_ARGUMENT');
  return { mode, target, planDigest: values['plan-digest'] || null };
}
function assertDigest(expected, actual) {
  if (!/^[a-f0-9]{64}$/.test(expected || '') || expected !== actual) refuse('DIGEST_MISMATCH');
}
function assertPreflight(row, target, readOnly = true) {
  guardTarget(target);
  exactKeys(row, ['database', 'host', 'port', 'user', 'default_read_only', 'read_only', 'encoding', 'version_num'], 'PREFLIGHT_FAILED');
  if (row.database !== target.database || row.host !== target.host || row.port !== target.port || row.user !== target.user ||
      row.default_read_only !== 'on' || row.read_only !== (readOnly ? 'on' : 'off') || row.encoding !== 'UTF8' ||
      !Number.isInteger(row.version_num) || row.version_num < 180000 || row.version_num >= 190000) refuse('PREFLIGHT_FAILED');
}
// Do not enumerate the parent environment. pgpass is located by native libpq using APPDATA.
// All PG* options are constructed here; no inherited connection, service or credential values.
function nativeEnvironment(parent) {
  if (!parent.SystemRoot || !parent.APPDATA) refuse('PROCESS_FAILED');
  return { SystemRoot: parent.SystemRoot, APPDATA: parent.APPDATA,
    PGCLIENTENCODING: 'UTF8', PGCONNECT_TIMEOUT: '5',
    PGOPTIONS: '-c default_transaction_read_only=on -c statement_timeout=30000 -c lock_timeout=3000 -c idle_in_transaction_session_timeout=15000 -c search_path=pg_catalog,public -c client_min_messages=error' };
}
function safeCode(error) { return CODES.includes(error?.code) ? error.code : 'PROCESS_FAILED'; }
module.exports = { TARGET, PSQL, PROFILE, CODES, refuse, hash, stable, exactKeys, guardTarget,
  parseArgs, assertDigest, assertPreflight, nativeEnvironment, safeCode };
