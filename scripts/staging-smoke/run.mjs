import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { demand, gitState, validate, validateHealth, validateIdentity, identitySql } from './guards.mjs';
import { sealNetwork } from './network.mjs';
import { inspect, validateFixture, createDomain, sign } from './signature.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

export async function execute({ env, args, git, target, health, connect, domain, network = sealNetwork }) {
  const config = validate(env, args, git, target);
  const response = await health(target.origin); validateHealth(response.status, response.body);
  const restoreNetwork = network(config.host);
  let client;
  try {
    client = await connect(config);
    // Read-only preflight on the same authenticated TLS session later used for the transaction.
    await client.query('BEGIN READ ONLY');
    validateIdentity((await client.query(identitySql)).rows[0], target);
    const services = domain(client);
    await services.validateSchema();
    const initial = await inspect(client, args.contractId); validateFixture(initial, args.smokeId);
    await client.query('ROLLBACK');
    await client.query('BEGIN');
    // Serialize re-execution per contract; all conditions are checked again before domain writes.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['staging-smoke:' + args.contractId]);
    await client.query('SELECT id FROM fechamentos WHERE id=$1 FOR UPDATE', [initial.fechamento_id]);
    validate(env, args, git, target);
    validateIdentity((await client.query(identitySql)).rows[0], target);
    const locked = await inspect(client, args.contractId);
    demand(locked.versao_id === initial.versao_id && locked.snapshot_hash === initial.snapshot_hash
      && locked.pdf_hash === initial.pdf_hash, 'CONTRACT_CHANGED_DURING_PREFLIGHT');
    validateFixture(locked, args.smokeId);
    const result = await sign(services, locked, args.smokeId, args.commit, () => inspect(client, args.contractId));
    await client.query('COMMIT');
    return result;
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { try { if (client) await client.end(); } finally { restoreNetwork(); } }
}

async function main() {
  const { values } = parseArgs({ strict: true, allowPositionals: false, options: {
    'execute-staging-smoke': { type: 'boolean' }, 'expected-commit': { type: 'string' },
    'smoke-id': { type: 'string' }, 'contract-id': { type: 'string' },
  } });
  const args = { execute: values['execute-staging-smoke'], commit: values['expected-commit'],
    smokeId: values['smoke-id'], contractId: values['contract-id'] };
  const env = Object.freeze({ ...process.env });
  const target = JSON.parse(readFileSync(new URL('./target.json', import.meta.url), 'utf8'));
  // No dotenv, CLI secrets, env/provider overrides or web entry points.
  return execute({ env, args, git: gitState(root), target,
    health: async origin => {
      const r = await fetch(new URL('/api/health', origin), { redirect: 'error', signal: AbortSignal.timeout(10000) });
      const text = await r.text(); demand(text.length <= 65536, 'HEALTH_TOO_LARGE');
      return { status: r.status, body: JSON.parse(text) };
    },
    connect: async config => { const { Client } = await import('pg'); const c = new Client(config);
      c.on('error', () => {}); try { await c.connect(); return c; } catch (e) { await c.end().catch(() => {}); throw e; } },
    domain: client => createDomain(resolve(root), env, client),
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Domain errors may contain CPF, code or tokens. Never print them, including stacks/causes.
  const output = process.stdout.write.bind(process.stdout);
  for (const key of ['log', 'info', 'warn', 'error', 'debug', 'trace']) console[key] = () => {};
  process.on('uncaughtException', () => { output('{"ok":false,"code":"STAGING_SMOKE_ABORTED"}\n'); process.exit(1); });
  main().then(result => output(JSON.stringify(result) + '\n')).catch(() => {
    output('{"ok":false,"code":"STAGING_SMOKE_ABORTED","details":"No credentials, OTP or tokens logged. Inspect guards before retrying."}\n');
    process.exitCode = 1;
  });
}
