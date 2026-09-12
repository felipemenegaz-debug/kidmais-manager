/* eslint-disable @typescript-eslint/no-require-imports */
// Somente leitura no banco físico; compara com o checkpoint atual pré-template.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const { Client } = require('pg');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
async function main() {
  const { dest } = JSON.parse(fs.readFileSync('.tmp/checkpoint-modelos.json'));
  const baseline = JSON.parse(fs.readFileSync(dest + '/dados.json'));
  const old = new Map(JSON.parse(fs.readFileSync(dest + '/manifesto.json')).map(x => [x.path, x.sha256]));
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    assert.equal((await c.query('SELECT current_database() db')).rows[0].db, 'kidmais_manager');
    const tables = (await c.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows.map(x => x.tablename);
    assert.deepEqual(tables, Object.keys(baseline));
    for (const t of tables) {
      const rows = (await c.query('SELECT to_jsonb(t)::text AS row FROM public."' + t.replaceAll('"', '""') + '" t ORDER BY to_jsonb(t)::text')).rows;
      assert.deepEqual({ count: rows.length, sha256: sha(JSON.stringify(rows)) }, baseline[t], 'Dados alterados: ' + t);
    }
    const catalog = {
      columns: (await c.query("SELECT table_name,column_name,data_type,column_default,is_nullable FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position")).rows,
      constraints: (await c.query("SELECT conrelid::regclass::text AS tabela,conname,pg_get_constraintdef(oid) AS definicao FROM pg_constraint WHERE connamespace='public'::regnamespace ORDER BY 1,2")).rows,
      triggers: (await c.query("SELECT tgrelid::regclass::text AS tabela,pg_get_triggerdef(oid) AS definicao FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1,2")).rows,
    };
    assert.deepEqual(catalog, JSON.parse(fs.readFileSync(dest + '/catalogo.json')));
    await c.query('COMMIT');
  } finally { await c.end(); }
  const arquivos = [];
  function walk(dir = '') {
    for (const e of fs.readdirSync(dir || '.', { withFileTypes: true })) {
      if (['node_modules', '.next', '.tmp', '.backups', '.git'].includes(e.name)) continue;
      const p = path.join(dir, e.name).replaceAll('\\', '/');
      if (e.isDirectory()) walk(p);
      else if (!p.endsWith('.tsbuildinfo') && sha(fs.readFileSync(p)) !== old.get(p)) arquivos.push({ path: p, status: old.has(p) ? 'alterado' : 'novo' });
    }
  }
  walk();
  for (const [p, hash] of old) if (/^database\/|schema_mvp_kidmais\.sql$|^lib\/pagamentos\/|^\.env.local$/.test(p)) assert.equal(sha(fs.readFileSync(p)), hash, p);
  for (const item of arquivos) assert(!/^database\//.test(item.path), 'Nenhum SQL novo permitido');
  const result = { checkpoint: dest, banco: 'kidmais_manager', tabelasIntactas: Object.keys(baseline).length, catalogoIntacto: true, documentosIntactos: baseline.contrato_documentos.count, divergencias: [], arquivos };
  fs.writeFileSync('.tmp/modelos-oficiais-integridade.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
