/* eslint-disable @typescript-eslint/no-require-imports */
// Opera somente em banco cujo nome inicia kidmais_013_test_. Sem seed no banco real.
const fs = require('node:fs');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const checkpoint = '.backups/pre-013-20260909-183215';
const sql = name => fs.readFileSync(`database/${name}`, 'utf8');
const pre = sql('checks/20260909_013_precheck.sql');
const up = sql('migrations/20260909_013_autenticacao_contrato.sql');
const post = sql('checks/20260909_013_postcheck.sql');
const down = sql('checks/20260909_013_rollback.sql');
async function main() {
 const source = new URL(process.env.DATABASE_URL);
 const name = `kidmais_013_test_${Date.now()}`;
 assert.match(name, /^kidmais_013_test_\d+$/);
 const admin = new Client({ connectionString: source.toString() });
 await admin.connect();
 await admin.query(`CREATE DATABASE "${name}"`);
 await admin.end();
 const restored = cp.spawnSync('C:/Program Files/PostgreSQL/18/bin/pg_restore.exe', [
  '-h', source.hostname, '-p', source.port || '5432', '-U', decodeURIComponent(source.username),
  '-d', name, '--exit-on-error', `${checkpoint}/banco.dump`,
 ], { env: { ...process.env, PGPASSWORD: decodeURIComponent(source.password) }, encoding: 'utf8' });
 assert.equal(restored.status, 0, 'restauração isolada falhou');
 source.pathname = '/' + name;
 const c = new Client({ connectionString: source.toString() });
 await c.connect();
 const results = [];
 try {
  await c.query(pre); await c.query(up); await c.query(post); results.push('UP e postcheck OK');
  const named = [...up.matchAll(/(?:\bCONSTRAINT\s+(?!TRIGGER)|CREATE\s+(?:UNIQUE\s+)?INDEX\s+|CREATE\s+(?:CONSTRAINT\s+)?TRIGGER\s+)(\w+)/g)].map(m=>m[1]);
  const physical = new Set((await c.query(`SELECT conname AS name FROM pg_constraint WHERE connamespace='public'::regnamespace UNION SELECT indexname FROM pg_indexes WHERE schemaname='public' UNION SELECT tgname FROM pg_trigger WHERE NOT tgisinternal`)).rows.map(r=>r.name));
  for (const n of named) assert(physical.has(n), `objeto ausente: ${n}`);
  results.push(`catálogo: ${named.length} objetos nomeados conferidos`);
  await c.query(down); await c.query(pre); results.push('DOWN vazio OK');
  await c.query(up); await c.query(post); results.push('segundo UP OK');
  const salt = crypto.randomBytes(16); const key = crypto.scryptSync('synthetic-test-password-only',salt,64,{N:131072,r:8,p:1,maxmem:256*1024*1024});
  const hash = `scrypt$v=1$N=131072$r=8$p=1$${salt.toString('base64')}$${key.toString('base64')}`;
  await c.query(`INSERT INTO usuarios_administrativos(email,nome,senha_hash,papel) VALUES ('synthetic-013@example.invalid','Synthetic validation',$1,'REPRESENTANTE_AUTORIZADO')`,[hash]);
  let refused = false;
  try { await c.query(down); } catch(e) { refused = /Rollback recusado/.test(e.message); await c.query('ROLLBACK'); }
  assert(refused, 'DOWN deve recusar dados novos');
  assert.equal((await c.query('SELECT count(*)::int AS n FROM usuarios_administrativos')).rows[0].n,1);
  results.push('DOWN após uso recusado; usuário preservado');
  fs.writeFileSync(`${checkpoint}/teste-isolado.json`,JSON.stringify({banco:name,results},null,2));
  console.log(JSON.stringify({banco:name,results}));
 } finally { await c.end(); }
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
