import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
const require = createRequire(import.meta.url);
const { validarConfiguracao } = require('../regressao-v1-staging.cjs');

export function demand(condition, code) {
  if (!condition) throw new Error(code);
}

export function gitState(root, env = process.env) {
  // Only absence of metadata permits Render attestation. Broken/partial metadata
  // and failures from any Git command must never become a fallback.
  demand(!Object.keys(env).some(k => k.startsWith('GIT_')), 'GIT_OVERRIDE_FORBIDDEN');
  const exists = path => {
    try { lstatSync(path); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  };
  let directory = resolve(root), metadata = false;
  for (;;) {
    if (exists(resolve(directory, '.git'))
      || (exists(resolve(directory, 'HEAD')) && exists(resolve(directory, 'objects')))) {
      metadata = true; break;
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  if (!metadata) return { unavailable: true };
  const git = (...args) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  return { branch: git('branch', '--show-current'), head: git('rev-parse', 'HEAD'),
    staging: git('rev-parse', 'refs/remotes/origin/staging'), dirty: git('status', '--porcelain'),
    origin: git('remote', 'get-url', 'origin') };
}

export function validate(env, args, git, target) {
  demand(args.execute === true, 'MANUAL_EXECUTION_REQUIRED');
  demand(target.database && /^kidmais_staging(?:_[a-z0-9]+)*$/.test(target.database)
    && target.hosts.length > 0 && target.hosts.every(h => /^dpg-[a-z0-9]{20}-[a-z](?:\.virginia-postgres\.render\.com)?$/.test(h)), 'TARGET_NOT_PINNED');
  demand(target.serviceId === 'srv-daif418ae00c73e8k2gg' && target.serviceName === 'kidmais-manager-staging'
    && target.branch === 'staging' && target.origin === 'https://kidmais-manager-staging.onrender.com', 'SERVICE_NOT_PINNED');
  demand(env.KIDMAIS_DEPLOY_ENV === 'staging' && env.RENDER === 'true'
    && env.RENDER_SERVICE_ID === target.serviceId && env.RENDER_SERVICE_NAME === target.serviceName
    && env.RENDER_GIT_BRANCH === 'staging', 'STAGING_SERVICE_REQUIRED');
  demand(!env.NODE_OPTIONS && !env.NODE_TLS_REJECT_UNAUTHORIZED && !env.PGHOST && !env.PGSERVICE
    && !env.PGSERVICEFILE && !env.PGOPTIONS && !env.PGPASSWORD && !env.PGUSER && !env.PGDATABASE, 'AMBIENT_OVERRIDE_FORBIDDEN');
  demand(!Object.entries(env).some(([k, v]) => v && /(?:^|_)PRODUCTION(?:_|$)|(?:^|_)PRODUCAO(?:_|$)/i.test(k)), 'PRODUCTION_INDICATOR');
  demand(env.IDENTIDADE_OTP_PROVIDER === 'gupshup' && env.GUPSHUP_OTP_ENABLED === 'false'
    && env.KIDMAIS_STAGING_OTP_DISABLED === 'SIM', 'EXTERNAL_OTP_MUST_STAY_DISABLED');
  demand(env.FESTA_ENABLED === 'true' && env.NODE_ENV === 'production', 'RUNTIME_MISMATCH');
  demand(/^[a-f0-9]{40}$/.test(args.commit) && args.commit === env.RENDER_GIT_COMMIT, 'REVISION_MISMATCH');
  if (git?.unavailable === true) {
    demand(Object.keys(git).length === 1, 'REVISION_MISMATCH');
  } else {
    demand(git && args.commit === git.head && git.head === git.staging
      && git.branch === target.branch && !git.dirty
      && git.origin === 'https://github.com/felipemenegaz-debug/kidmais-manager.git', 'REVISION_MISMATCH');
  }
  demand(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(args.smokeId)
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(args.contractId), 'INVALID_SMOKE_IDENTIFIERS');
  let url;
  try { url = new URL(env.KIDMAIS_STAGING_DATABASE_URL); } catch { throw new Error('TARGET_INVALID'); }
  demand(url.pathname === '/' + target.database && target.hosts.includes(url.hostname)
    && (!url.port || url.port === '5432') && !url.hash && url.search === '?sslmode=verify-full'
    && !/prod|producao|kidmais_manager/i.test(url.hostname + url.pathname + decodeURIComponent(url.username)), 'TARGET_MISMATCH');
  demand(!env.DATABASE_URL || env.DATABASE_URL === env.KIDMAIS_STAGING_DATABASE_URL, 'SECOND_DATABASE_FORBIDDEN');
  // Reuse the existing staging runner's exact-name/host, remote-only and TLS checks.
  try { validarConfiguracao({ ...env, KIDMAIS_REGRESSAO_STAGING: 'SIM',
    KIDMAIS_STAGING_DATABASE_NAME: target.database, KIDMAIS_STAGING_DATABASE_HOST: url.hostname }); }
  catch { throw new Error('STAGING_DATABASE_GUARD'); }
  demand(env.IDENTIDADE_OTP_PEPPER?.trim().length >= 16, 'IDENTITY_CONFIGURATION_REQUIRED');
  return { host: url.hostname, port: 5432, database: target.database,
    user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
    ssl: { rejectUnauthorized: true, servername: url.hostname },
    connectionTimeoutMillis: 5000, query_timeout: 20000,
    options: '-c statement_timeout=20000 -c lock_timeout=5000', application_name: 'kidmais-staging-signature-smoke' };
}

export function validateHealth(status, body) {
  demand(status === 200 && body?.ok === true && body.status === 'degraded'
    && body.components?.database === 'ready' && body.components.festa === 'ready'
    && body.components.otp === 'unavailable' && body.otp?.provider === 'gupshup'
    && body.otp.configured === true && body.otp.enabled === false
    && body.otp.reason === 'staging_disabled', 'STAGING_HEALTH_MISMATCH');
}

export function validateIdentity(row, target) {
  demand(row?.database === target.database && row.tls === true && row.port === 5432
    && row.superuser === false && row.create_db === false && row.create_role === false
    && row.replication === false && row.bypass_rls === false, 'PHYSICAL_TARGET_OR_ROLE_REFUSED');
}

export const identitySql = `SELECT current_database() AS database, inet_server_port() AS port,
 COALESCE((SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()),false) AS tls,
 rolsuper AS superuser, rolcreatedb AS create_db, rolcreaterole AS create_role,
 rolreplication AS replication, rolbypassrls AS bypass_rls FROM pg_roles WHERE rolname=current_user`;
