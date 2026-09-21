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
  // Missing metadata permits Render attestation; existing metadata stays mandatory.
  // Git command failures never become a fallback, including remote discovery.
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
  const git = (...args) => {
    const output = execFileSync('git', args, { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    // Keep porcelain XY columns and path bytes intact; remove only the final EOL.
    return args[0] === 'status' ? output.replace(/\r?\n$/, '') : output.trim();
  };
  return readGitMetadata(git);
}

export function readGitMetadata(git) {
  const state = { branch: git('branch', '--show-current'), head: git('rev-parse', 'HEAD'),
    staging: git('rev-parse', 'refs/remotes/origin/staging'), dirty: git('status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none') };
  // Confirm absence via a successful listing; never catch a failed get-url.
  const hasOrigin = git('remote').split(/\r?\n/).includes('origin');
  return { ...state, origin: hasOrigin ? git('remote', 'get-url', 'origin') : null };
}

export function validateGitRevision(git, commit, env = {}, target = {}) {
  const render = env.RENDER === 'true' && env.KIDMAIS_DEPLOY_ENV === 'staging'
    && env.RENDER_SERVICE_ID === 'srv-daif418ae00c73e8k2gg'
    && env.RENDER_SERVICE_NAME === 'kidmais-manager-staging' && env.RENDER_GIT_BRANCH === 'staging'
    && /^[a-f0-9]{40}$/.test(commit) && env.RENDER_GIT_COMMIT === commit
    && target.serviceId === env.RENDER_SERVICE_ID && target.serviceName === env.RENDER_SERVICE_NAME
    && target.branch === 'staging' && target.origin === 'https://kidmais-manager-staging.onrender.com';
  const allowedDirty = render && [' M data/disponibilidade.json', 'M  data/disponibilidade.json',
    'MM data/disponibilidade.json'].includes(git?.dirty);
  demand(git && /^[a-f0-9]{40}$/.test(commit) && git.head === commit && git.staging === commit
    && (git.branch === 'staging' || (render && git.branch === ''))
    && (git.dirty === '' || allowedDirty)
    && (git.origin === 'https://github.com/felipemenegaz-debug/kidmais-manager.git'
      || (render && git.origin === null)), 'REVISION_MISMATCH');
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
    validateGitRevision(git, args.commit, env, target);
  }
  demand(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(args.smokeId)
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(args.contractId), 'INVALID_SMOKE_IDENTIFIERS');
  let url;
  try { url = new URL(env.KIDMAIS_STAGING_DATABASE_URL); } catch { throw new Error('TARGET_INVALID'); }
  demand(url.pathname === '/' + target.database && target.hosts.includes(url.hostname)
    && target.database === 'kidmais_staging_1z91' && url.hostname === 'dpg-daidko3m8hqs73ce4jt0-a'
    && (!url.port || url.port === '5432') && !url.hash && url.search === '?sslmode=require'
    && !/prod|producao|kidmais_manager/i.test(url.hostname + url.pathname + decodeURIComponent(url.username)), 'TARGET_MISMATCH');
  demand(!env.DATABASE_URL || env.DATABASE_URL === env.KIDMAIS_STAGING_DATABASE_URL, 'SECOND_DATABASE_FORBIDDEN');
  // Reuse the existing staging runner's exact-name/host, remote-only and TLS checks.
  try { validarConfiguracao({ ...env, KIDMAIS_REGRESSAO_STAGING: 'SIM',
    KIDMAIS_STAGING_DATABASE_NAME: target.database, KIDMAIS_STAGING_DATABASE_HOST: url.hostname }); }
  catch { throw new Error('STAGING_DATABASE_GUARD'); }
  demand(env.IDENTIDADE_OTP_PEPPER?.trim().length >= 16, 'IDENTITY_CONFIGURATION_REQUIRED');
  return { host: url.hostname, port: 5432, database: target.database,
    user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
    // Render private PostgreSQL uses a self-signed certificate. TLS is mandatory;
    // the exact internal target above and pg_stat_ssl below remain mandatory too.
    ssl: { rejectUnauthorized: false, servername: url.hostname },
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
