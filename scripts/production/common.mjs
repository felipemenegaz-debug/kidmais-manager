import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function isMain(url) {
  return !!process.argv[1] && url === pathToFileURL(resolve(process.argv[1])).href;
}
const result = (check) => ({ schemaVersion: 2, check, blockers: [], unknown: [], pending: [], reported: [], evidence: [],
  get status() { return this.blockers.length ? 'FAIL_VERIFIED' : this.unknown.length ? 'UNKNOWN' : 'PASS'; }
});
function parseArgs(args, allowed) {
  const options = {};
  for (const arg of args) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (!match || !(match[1] in allowed) || match[1] in options) throw new Error('ARGUMENT_INVALID');
    const value = match[2];
    if (allowed[match[1]] === 'boolean' ? value !== undefined : !value) throw new Error('ARGUMENT_INVALID');
    options[match[1]] = value ?? true;
  }
  return options;
}
function finish(r, json) {
  const output = { ...r, ok: r.blockers.length === 0 && r.unknown.length === 0 };
  console.log(json ? JSON.stringify(output) : [r.check + ': ' + (r.decision ?? r.status), ...r.blockers.map(x => 'FAIL_VERIFIED: ' + x), ...r.unknown.map(x => 'UNKNOWN: ' + x), ...r.pending.map(x => 'PENDING: ' + x), ...r.reported.map(x => 'PASS_REPORTED: ' + JSON.stringify(x)), ...r.evidence.map(x => 'EVIDENCE: ' + JSON.stringify(x))].join('\n'));
  process.exitCode = output.ok ? 0 : 1;
}
async function cli(name, allowed, run) {
  try { const options = parseArgs(process.argv.slice(2), { json: 'boolean', ...allowed }); finish(await run(process.env, options), options.json); }
  catch { const r = result(name); r.blockers.push('CHECK_FAILED_OR_ARGUMENT_INVALID'); finish(r, process.argv.includes('--json')); }
}
export { result, cli, isMain };
