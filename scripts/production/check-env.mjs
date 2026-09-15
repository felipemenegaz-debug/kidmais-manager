import { result, cli, isMain } from './common.mjs';
import { target, allowsInternalTls } from './check-database-target.mjs';
function check(env) {
  const r = result('env');
  const requireValue = (key, valid) => { if (!env[key]?.trim()) r.unknown.push('LOCAL:' + key + '_NOT_AVAILABLE'); else if (!valid(env[key])) r.blockers.push('LOCAL:' + key + '_INVALID'); };
  for (const [key, value] of Object.entries({ NODE_ENV: 'production', NODE_VERSION: '22.23.2', FESTA_ENABLED: 'true', CONTRATO_ACEITE_DEV_ENABLED: 'false' })) requireValue(key, x => x === value);
  requireValue('KIDMAIS_DEPLOY_ENV', x => ['staging', 'production'].includes(x));
  const db = target(env);
  r.blockers.push(...db.blockers);
  r.unknown.push(...db.unknown.filter(x => !r.unknown.includes(x)));
  for (const key of ['DATABASE_POOL_MAX', 'DATABASE_CONNECTION_TIMEOUT_MS', 'DATABASE_IDLE_TIMEOUT_MS', 'WHATSAPP_CREDENTIAL_KEY_VERSION']) requireValue(key, x => /^[1-9]\d*$/.test(x) && Number.isSafeInteger(Number(x)) && Number(x) <= 2147483647);
  for (const key of ['DATABASE_SSL', 'DATABASE_SSL_REJECT_UNAUTHORIZED']) requireValue(key, x => ['true', 'false'].includes(x));
  if (env.KIDMAIS_DEPLOY_ENV === 'production') {
    if (env.DATABASE_SSL === 'false') r.blockers.push('LOCAL:PRODUCTION_TLS_REQUIRED');
    if (env.DATABASE_SSL_REJECT_UNAUTHORIZED === 'false') {
      if (allowsInternalTls(env, db)) {
        r.evidence.push({ source: 'script', scope: 'LOCAL', validation: 'tls-policy', connectionType: 'RENDER_INTERNAL', certificateVerification: false, remoteState: 'not-verified' });
      } else if (db.connectionType === 'EXTERNAL') r.blockers.push('LOCAL:PRODUCTION_CERTIFICATE_VERIFICATION_REQUIRED');
      else if (!db.blockers.length) r.unknown.push('LOCAL:TLS_INTERNAL_DESTINATION_NOT_VERIFIED');
    }
  }
  requireValue('ADMIN_AUTH_ORIGIN', x => { try { const u = new URL(x); return u.protocol === 'https:' && u.origin === x && !u.username && !u.password && !u.hostname.includes('localhost') && !(env.KIDMAIS_DEPLOY_ENV === 'production' && u.hostname.includes('staging')); } catch { return false; } });
  requireValue('ADMIN_AUTH_SECRET', x => x.trim().length >= 32);
  requireValue('IDENTIDADE_OTP_PEPPER', x => x.trim().length >= 16);
  requireValue('WHATSAPP_CREDENTIAL_ENCRYPTION_KEY', x => /^[A-Za-z0-9+/]{43}=$/.test(x) && Buffer.from(x, 'base64').length === 32);
  if (env.KIDMAIS_DEPLOY_ENV === 'production' && Object.keys(env).some(k => k.startsWith('KIDMAIS_STAGING_') && env[k])) r.blockers.push('LOCAL:STAGING_FLAG_IN_PRODUCTION');
  if (env.IDENTIDADE_OTP_PROVIDER === 'console') r.blockers.push('LOCAL:OTP_CONSOLE_FORBIDDEN');
  if (env.IDENTIDADE_OTP_PROVIDER === 'disabled') {
    if (env.KIDMAIS_DEPLOY_ENV === 'production') r.blockers.push('LOCAL:OTP_DISABLED_NOT_AUTHORIZED');
    else if (env.KIDMAIS_DEPLOY_ENV === 'staging' && !env.KIDMAIS_STAGING_OTP_DISABLED) r.unknown.push('LOCAL:KIDMAIS_STAGING_OTP_DISABLED_NOT_AVAILABLE');
    else if (env.KIDMAIS_DEPLOY_ENV === 'staging' && env.KIDMAIS_STAGING_OTP_DISABLED !== 'SIM') r.blockers.push('LOCAL:OTP_DISABLED_NOT_AUTHORIZED');
  }
  r.pending.push('WHATSAPP_OTP_DELIVERY_REQUIRES_EXTERNAL_VALIDATION');
  r.evidence.push({ source: 'script', scope: 'LOCAL', validation: 'environment-only', remoteState: 'not-verified', secretValuesPrinted: false });
  return r;
}
if (isMain(import.meta.url)) cli('env', {}, check);
export { check };
