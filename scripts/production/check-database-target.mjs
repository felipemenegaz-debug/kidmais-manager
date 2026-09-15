import { result, cli, isMain } from './common.mjs';
function target(env) {
  const r = result('database-target');
  r.evidence.push({ source: 'script', scope: 'LOCAL', connected: false, remoteState: 'not-verified' });
  if (!env.DATABASE_URL?.trim()) r.unknown.push('LOCAL:DATABASE_URL_NOT_AVAILABLE');
  if (!env.KIDMAIS_DEPLOY_ENV?.trim()) r.unknown.push('LOCAL:KIDMAIS_DEPLOY_ENV_NOT_AVAILABLE');
  if (env.KIDMAIS_DEPLOY_ENV?.trim() && !['staging', 'production'].includes(env.KIDMAIS_DEPLOY_ENV)) r.blockers.push('LOCAL:DEPLOY_ENV_INVALID');
  if (!env.DATABASE_URL?.trim()) return r;
  let url;
  try {
    url = new URL(env.DATABASE_URL);
    const database = decodeURIComponent(url.pathname.slice(1));
    const username = decodeURIComponent(url.username);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !username || !url.password || url.search || url.hash || !/^[a-zA-Z0-9_-]+$/.test(database)) throw new Error();
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    const local = host === 'localhost' || host.endsWith('.localhost') || /^127\./.test(host) || host.includes(':') || /^(?:0x[0-9a-f]+|[0-9]+)(?:\.(?:0x[0-9a-f]+|[0-9]+))*$/.test(host);
    if (database === 'kidmais_manager' || (env.KIDMAIS_DEPLOY_ENV === 'production' && (database !== 'kidmais_production' || local)) || (env.KIDMAIS_DEPLOY_ENV === 'staging' && ['kidmais_production', 'kidmais-production'].includes(database))) {
      r.blockers.push('LOCAL:DATABASE_TARGET_FORBIDDEN');
    }
    // Do not echo even permitted URL fields: they can contain user-supplied sensitive text.
    r.evidence.push({ source: 'script', scope: 'LOCAL', status: 'PASS', validation: 'url-parsed', connected: false });
  } catch { r.blockers.push('LOCAL:DATABASE_URL_INVALID'); }
  return r;
}
async function readDatabase(env, query, loadPg = () => import('pg')) {
  const validation = target(env);
  if (validation.blockers.length || validation.unknown.length) throw new Error('TARGET_REFUSED');
  if (env.DATABASE_SSL !== 'true' || env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'true') throw new Error('TLS_REQUIRED');
  const { Client } = await loadPg();
  const client = new Client({ connectionString: env.DATABASE_URL, ssl: { rejectUnauthorized: true }, connectionTimeoutMillis: 5000, query_timeout: 5000, options: '-c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=2000' });
  client.on('error', () => {});
  try {
    await client.connect();
    const identity = await client.query('SELECT current_database() AS database, session_user, current_user');
    if (identity.rows[0]?.database !== decodeURIComponent(new URL(env.DATABASE_URL).pathname.slice(1))) throw new Error('TARGET_MISMATCH');
    return await client.query(query);
  } finally { await client.end(); }
}
async function check(env, options = {}, loadPg = () => import('pg')) {
  const r = target(env);
  if (options.connect && !r.blockers.length && !r.unknown.length) {
    try { const data = await readDatabase(env, "SELECT count(*)::int AS count FROM pg_tables WHERE schemaname='public'", loadPg); r.evidence.push({ source: 'script', connected: true, publicTables: Number(data.rows[0].count) }); }
    catch { r.unknown.push('OPERATIONAL:DATABASE_READ_NOT_VERIFIED'); }
  }
  return r;
}
if (isMain(import.meta.url)) cli('database-target', { connect: 'boolean' }, check);
export { check, target, readDatabase };
