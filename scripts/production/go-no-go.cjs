'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { result, cli } = require('./common.cjs');
const envCheck = require('./check-env.cjs');
const database = require('./check-database-target.cjs');
const migrations = require('./check-migrations.cjs');
const smoke = require('./smoke-test.cjs');
const gates = ['migrationsThrough018', 'credentialRotation', 'secretsExclusive', 'persistentDisk', 'https', 'backupRestore', 'adminSmoke', 'regression', 'monitoring', 'operationalAcceptance'];
function aggregate(results, operational, binding) {
  const r = result('go-no-go');
  r.blockers = results.flatMap(x => x.blockers.map(b => x.check + ':' + b));
  r.pending = results.flatMap(x => x.pending.map(p => x.check + ':' + p));
  r.evidence = results.map(x => ({ source: 'script', check: x.check, evidence: x.evidence }));
  const bound = Object.values(binding).every(x => typeof x === 'string' && x.length > 0) && operational?.schemaVersion === 1 && operational.environment === binding.environment && operational.commit === binding.commit && operational.origin === binding.origin && operational.database === binding.database && Number.isFinite(Date.parse(operational.verifiedAt)) && Date.parse(operational.verifiedAt) <= Date.now() && Date.now() - Date.parse(operational.verifiedAt) <= 86400000;
  for (const gate of gates) {
    const confirmed = bound && operational[gate] === true;
    if (!confirmed) r.blockers.push('OPERATIONAL_EVIDENCE_REQUIRED_' + gate);
    r.evidence.push({ source: 'external-report', gate, confirmed: !!confirmed });
  }
  const commercial = bound && operational.whatsappDelivery === true && results.some(x => x.check === 'smoke' && x.evidence.some(e => e.otpReady === true));
  if (bound && operational.migrationsThrough018 === true) r.pending = r.pending.filter(x => !x.endsWith('MIGRATION_STATE_REQUIRES_REVIEWED_EXTERNAL_EVIDENCE'));
  if (commercial) r.pending = r.pending.filter(x => !x.endsWith('WHATSAPP_OTP_DELIVERY_REQUIRES_EXTERNAL_VALIDATION') && !x.endsWith('HEALTH_DOES_NOT_PROVE_WHATSAPP_DELIVERY'));
  if (!commercial) r.pending.push('WHATSAPP_COMMERCIAL_NOT_VALIDATED');
  r.decision = r.blockers.length ? 'NO-GO' : commercial ? 'GO' : 'GO-PARCIAL';
  r.technical = r.blockers.length ? 'NO-GO' : 'GO';
  r.commercialWhatsapp = r.blockers.length || !commercial ? 'NO-GO' : 'GO';
  r.released = r.blockers.length ? ['Planejar e corrigir os bloqueadores com aprovações aplicáveis'] : ['Preparação técnica e avaliação dos fluxos administrativos independentes de WhatsApp'];
  r.blocked = [...(r.blockers.length ? ['Liberação técnica para operação'] : []), ...(!commercial ? ['Fluxos comerciais dependentes de WhatsApp/OTP'] : []), 'Qualquer mudança de infraestrutura ou liberação de tráfego sem aprovação humana'];
  return r;
}
async function check(env, options = {}) {
  const results = [envCheck.check(env), await database.check(env), await migrations.check(env), await smoke.check(env, options)];
  let operational;
  if (options.evidence) {
    try { if (fs.statSync(options.evidence).size > 16384) throw new Error(); operational = JSON.parse(fs.readFileSync(options.evidence, 'utf8')); }
    catch { const r = result('operational'); r.blockers.push('EVIDENCE_INVALID'); results.push(r); }
  }
  let commit;
  try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path.resolve(__dirname, '../..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); } catch { /* Missing binding fails closed. */ }
  let origin; let db;
  try { origin = new URL(options['base-url']).origin; db = decodeURIComponent(new URL(env.DATABASE_URL).pathname.slice(1)); } catch { /* Checks above report invalid input. */ }
  if (origin && origin !== env.ADMIN_AUTH_ORIGIN) { const r = result('binding'); r.blockers.push('SMOKE_ADMIN_ORIGIN_MISMATCH'); results.push(r); }
  return aggregate(results, operational, { environment: env.KIDMAIS_DEPLOY_ENV, commit, origin, database: db });
}
if (require.main === module) cli('go-no-go', { 'base-url': 'string', evidence: 'string' }, check);
module.exports = { check, aggregate, gates };
