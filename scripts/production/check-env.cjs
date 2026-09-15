'use strict';
const { result, cli } = require('./common.cjs');
const { target } = require('./check-database-target.cjs');
function check(env) {
  const r = result('env');
  const requireValue = (key, valid) => { if (!env[key]?.trim()) r.blockers.push(key + '_MISSING'); else if (!valid(env[key])) r.blockers.push(key + '_INVALID'); };
  for (const [key, value] of Object.entries({ NODE_ENV: 'production', NODE_VERSION: '22.23.2', FESTA_ENABLED: 'true', CONTRATO_ACEITE_DEV_ENABLED: 'false' })) requireValue(key, x => x === value);
  requireValue('KIDMAIS_DEPLOY_ENV', x => ['staging', 'production'].includes(x));
  requireValue('DATABASE_URL', () => target(env).blockers.length === 0);
  for (const key of ['DATABASE_POOL_MAX', 'DATABASE_CONNECTION_TIMEOUT_MS', 'DATABASE_IDLE_TIMEOUT_MS', 'WHATSAPP_CREDENTIAL_KEY_VERSION']) requireValue(key, x => /^[1-9]\d*$/.test(x) && Number.isSafeInteger(Number(x)) && Number(x) <= 2147483647);
  for (const key of ['DATABASE_SSL', 'DATABASE_SSL_REJECT_UNAUTHORIZED']) requireValue(key, x => ['true', 'false'].includes(x));
  if (env.KIDMAIS_DEPLOY_ENV === 'production' && (env.DATABASE_SSL !== 'true' || env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'true')) r.blockers.push('PRODUCTION_TLS_REQUIRED');
  requireValue('ADMIN_AUTH_ORIGIN', x => { try { const u = new URL(x); return u.protocol === 'https:' && u.origin === x && !u.username && !u.password && !u.hostname.includes('localhost') && !(env.KIDMAIS_DEPLOY_ENV === 'production' && u.hostname.includes('staging')); } catch { return false; } });
  requireValue('ADMIN_AUTH_SECRET', x => x.trim().length >= 32);
  requireValue('IDENTIDADE_OTP_PEPPER', x => x.trim().length >= 16);
  requireValue('WHATSAPP_CREDENTIAL_ENCRYPTION_KEY', x => /^[A-Za-z0-9+/]{43}=$/.test(x) && Buffer.from(x, 'base64').length === 32);
  if (env.KIDMAIS_DEPLOY_ENV === 'production' && Object.keys(env).some(k => k.startsWith('KIDMAIS_STAGING_') && env[k])) r.blockers.push('STAGING_FLAG_IN_PRODUCTION');
  if (env.IDENTIDADE_OTP_PROVIDER === 'console') r.blockers.push('OTP_CONSOLE_FORBIDDEN');
  if (env.IDENTIDADE_OTP_PROVIDER === 'disabled' && !(env.KIDMAIS_DEPLOY_ENV === 'staging' && env.KIDMAIS_STAGING_OTP_DISABLED === 'SIM')) r.blockers.push('OTP_DISABLED_NOT_AUTHORIZED');
  r.pending.push('WHATSAPP_OTP_DELIVERY_REQUIRES_EXTERNAL_VALIDATION');
  r.evidence.push({ source: 'script', validation: 'environment-only', secretValuesPrinted: false });
  return r;
}
if (require.main === module) cli('env', {}, check);
module.exports = { check };
