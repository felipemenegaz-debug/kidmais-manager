import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { result, cli, isMain } from './common.mjs';
import * as envCheck from './check-env.mjs';
import * as database from './check-database-target.mjs';
import * as migrations from './check-migrations.mjs';
import * as smoke from './smoke-test.mjs';
const gates = ['migrationsThrough018', 'credentialRotation', 'secretsExclusive', 'persistentDisk', 'https', 'backupRestore', 'adminSmoke', 'regression', 'monitoring', 'operationalAcceptance'];
// Read only a narrow, explicit report. Never emit arbitrary handoff text or JSON values.
function handoffReports(markdown) {
  const blocks = [...markdown.matchAll(/```production-operational-report\r?\n([\s\S]*?)\r?\n```/g)];
  if (blocks.length !== 1) return [];
  try {
    const value = JSON.parse(blocks[0][1]);
    const facts = ['databaseUrlUpdated', 'loginValidated', 'zeroTablesBeforeMigrations', 'noOldCredentialConnections', 'oldCredentialRevoked', 'connectionAfterRevocation', 'stagingNotInvolved'];
    if (value.schemaVersion !== 1 || value.environment !== 'production' || value.gate !== 'credentialRotation' || value.confirmation !== 'confirmed-outside-this-execution' || value.database !== 'kidmais_production' || value.sessionUser !== 'kidmais_production_app_v2' || !facts.every(key => value[key] === true)) return [];
    return [{ source: 'handoff', scope: 'OPERATIONAL', status: 'PASS_REPORTED', gate: 'credentialRotation', directlyVerified: false, currentStateVerified: false }];
  } catch { return []; }
}
function aggregate(results, operational, binding, reports = []) {
  const r = result('go-no-go');
  r.blockers = results.flatMap(x => x.blockers.map(b => x.check + ':' + b));
  r.unknown = results.flatMap(x => x.unknown.map(b => x.check + ':' + b));
  r.reported = [...reports];
  r.pending = results.flatMap(x => x.pending.map(p => x.check + ':' + p));
  r.evidence = results.map(x => ({ source: 'script', check: x.check, status: x.status, evidence: x.evidence }));
  const bound = Object.values(binding).every(x => typeof x === 'string' && x.length > 0) && operational?.schemaVersion === 1 && operational.environment === binding.environment && operational.commit === binding.commit && operational.origin === binding.origin && operational.database === binding.database && Number.isFinite(Date.parse(operational.verifiedAt)) && Date.parse(operational.verifiedAt) <= Date.now() && Date.now() - Date.parse(operational.verifiedAt) <= 86400000;
  for (const gate of gates) {
    const confirmed = bound && operational[gate] === true;
    if (!confirmed) r.unknown.push('OPERATIONAL:CURRENT_EVIDENCE_REQUIRED_' + gate);
    else r.reported.push({ source: 'external-report', scope: 'OPERATIONAL', status: 'PASS_REPORTED', gate, directlyVerified: false });
    r.evidence.push({ source: 'external-report', scope: 'OPERATIONAL', status: confirmed ? 'PASS_REPORTED' : 'UNKNOWN', gate, confirmed: !!confirmed, directlyVerified: false });
  }
  const commercial = bound && operational.whatsappDelivery === true && results.some(x => x.check === 'smoke' && x.evidence.some(e => e.otpReady === true));
  if (commercial) r.pending = r.pending.filter(x => !x.endsWith('WHATSAPP_OTP_DELIVERY_REQUIRES_EXTERNAL_VALIDATION') && !x.endsWith('HEALTH_DOES_NOT_PROVE_WHATSAPP_DELIVERY'));
  if (!commercial) r.pending.push('WHATSAPP_COMMERCIAL_NOT_VALIDATED');
  for (const check of ['env', 'database-target', 'migrations', 'smoke']) if (!results.some(x => x.check === check)) r.unknown.push('LOCAL:CHECK_NOT_RUN_' + check);
  const insufficient = r.blockers.length || r.unknown.length;
  r.decision = insufficient ? 'NO-GO' : commercial ? 'GO' : 'GO-PARCIAL';
  r.technical = insufficient ? 'NO-GO' : 'GO';
  r.commercialWhatsapp = insufficient || !commercial ? 'NO-GO' : 'GO';
  r.released = insufficient ? ['Planejar correções e reunir evidências faltantes'] : ['Preparação técnica e avaliação dos fluxos administrativos independentes de WhatsApp'];
  r.blocked = [...(insufficient ? ['Liberação técnica para operação'] : []), ...(!commercial ? ['Fluxos comerciais dependentes de WhatsApp/OTP'] : []), 'Qualquer mudança de infraestrutura ou liberação de tráfego sem aprovação humana'];
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
  try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path.resolve(import.meta.dirname, '../..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); } catch { /* Missing binding fails closed. */ }
  let origin; let db;
  try { origin = new URL(options['base-url']).origin; db = decodeURIComponent(new URL(env.DATABASE_URL).pathname.slice(1)); } catch { /* Checks above report invalid input. */ }
  if (origin && env.ADMIN_AUTH_ORIGIN?.trim() && origin !== env.ADMIN_AUTH_ORIGIN) { const r = result('binding'); r.blockers.push('LOCAL:SMOKE_ADMIN_ORIGIN_MISMATCH'); results.push(r); }
  let reports = [];
  try { reports = handoffReports(fs.readFileSync(path.resolve(import.meta.dirname, '../../docs/HANDOFF_V1_PRODUCAO.md'), 'utf8')); }
  catch { /* Missing repository report supplies no operational evidence. */ }
  return aggregate(results, operational, { environment: env.KIDMAIS_DEPLOY_ENV, commit, origin, database: db }, reports);
}
if (isMain(import.meta.url)) cli('go-no-go', { 'base-url': 'string', evidence: 'string' }, check);
export { check, aggregate, gates, handoffReports };
