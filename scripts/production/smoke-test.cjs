'use strict';
const { result, cli } = require('./common.cjs');
function evaluate(env, statusCode, body) {
  const r = result('smoke');
  if (!['production', 'staging'].includes(env.KIDMAIS_DEPLOY_ENV)) r.blockers.push('DEPLOY_ENV_INVALID');
  if (statusCode !== 200) r.blockers.push('HEALTH_HTTP_NOT_200');
  if (body?.ok !== true) r.blockers.push('HEALTH_NOT_OK');
  for (const key of ['database', 'festa']) if (body?.components?.[key] !== 'ready') r.blockers.push(key.toUpperCase() + '_NOT_READY');
  const otp = body?.components?.otp;
  if (!['ready', 'unavailable'].includes(otp)) r.blockers.push('OTP_STATUS_INVALID');
  const expected = env.KIDMAIS_DEPLOY_ENV === 'staging' && env.IDENTIDADE_OTP_PROVIDER === 'disabled' && env.KIDMAIS_STAGING_OTP_DISABLED === 'SIM';
  if (body?.status !== (otp === 'unavailable' ? 'degraded' : 'ready')) r.blockers.push('HEALTH_STATUS_INCONSISTENT');
  if (otp === 'unavailable') {
    r.pending.push(expected ? 'STAGING_OTP_DISABLED_EXPECTED' : 'OTP_UNAVAILABLE');
    if (env.KIDMAIS_DEPLOY_ENV === 'staging' && !expected) r.blockers.push('STAGING_DEGRADED_NOT_AUTHORIZED');
  }
  r.pending.push('HEALTH_DOES_NOT_PROVE_WHATSAPP_DELIVERY');
  r.evidence.push({ source: 'script', httpStatus: statusCode, databaseReady: body?.components?.database === 'ready', festaReady: body?.components?.festa === 'ready', otpReady: otp === 'ready' });
  return r;
}
async function check(env, options = {}, fetcher = fetch) {
  const r = result('smoke');
  if (!options['base-url']) { r.blockers.push('SMOKE_URL_MISSING'); return r; }
  try {
    const url = new URL(options['base-url']);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error();
    const response = await fetcher(new URL('/api/health', url), { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10000), headers: { Accept: 'application/json' } });
    const reader = response.body.getReader();
    const chunks = []; let length = 0;
    try { while (true) { const { done, value } = await reader.read(); if (done) break; length += value.length; if (length > 65536) throw new Error(); chunks.push(Buffer.from(value)); } }
    finally { await reader.cancel(); }
    return evaluate(env, response.status, JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } catch { r.blockers.push('HEALTH_REQUEST_OR_JSON_INVALID'); return r; }
}
if (require.main === module) cli('smoke', { 'base-url': 'string' }, check);
module.exports = { check, evaluate };
