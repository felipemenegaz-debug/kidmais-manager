import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const migration = readFileSync('database/migrations/20260923_021_catalogo_configuravel_estrutura.sql', 'utf8');
const pre = readFileSync('database/checks/20260923_021_precheck.sql', 'utf8');
const post = readFileSync('database/checks/20260923_021_postcheck.sql', 'utf8');
const rollback = readFileSync('database/rollback/20260923_021_catalogo_configuravel_estrutura_down.sql', 'utf8');

test('021 tem número livre e preserva migrations anteriores', () => {
  const files = readdirSync('database/migrations');
  assert(files.some(name => /_017_pocket_sexta\.sql$/.test(name)));
  assert.equal(files.filter(name => /_021_/.test(name)).length, 1);
  assert.match(migration, /^BEGIN;/);
  assert.match(migration, /COMMIT;\s*$/);
});

test('estrutura é aditiva e não altera preços e snapshots históricos', () => {
  assert.doesNotMatch(migration, /(?:UPDATE|DELETE\s+FROM)\s+(?:precos_adicional|fechamentos|contrato_versoes|fechamento_adicionais)\b/i);
  assert.doesNotMatch(migration, /(?:DROP\s+(?:TABLE|COLUMN)|ALTER\s+TABLE\s+fechamentos)\b/i);
  assert.match(migration, /UPDATE adicionais a SET categoria_id = c\.id/);
  assert.match(migration, /ADD CONSTRAINT precos_adicional_valor_check CHECK \(valor >= 0\)/);
  for (const table of ['buffet_categorias','buffet_itens','pacote_buffet_categorias','pacote_buffet_itens',
    'fechamento_buffet_snapshots','fechamento_buffet_escolhas','adicional_categorias','pacote_adicionais','documentos_publicos']) {
    assert.match(migration, new RegExp(`CREATE TABLE ${table}\\b`));
    assert.match(post, new RegExp(`'${table}'`));
  }
  assert.match(migration, /CREATE UNIQUE INDEX documentos_publicos_um_ativo_idx ON documentos_publicos \(tipo\) WHERE ativo/);
  assert.match(migration, /FOREIGN KEY \(item_id, categoria_id\)\s+REFERENCES buffet_itens\(id, categoria_id\)/);
});

test('checks não escrevem e expõem contagens comparáveis', () => {
  for (const sql of [pre, post]) {
    assert.doesNotMatch(sql.replace(/^--.*$/gm, ''), /\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE)\s+(?:INTO|TABLE|FROM|INDEX|CONSTRAINT)\b/i);
    for (const name of ['adicionais','categorias','precos','fechamentos']) assert.match(sql, new RegExp(`AS ${name}\\b`));
  }
});

test('rollback recusa perda de escolhas, PDFs ou cortesias', () => {
  for (const name of ['fechamento_buffet_snapshots', 'fechamento_buffet_escolhas', 'pacote_adicionais', 'documentos_publicos']) {
    assert.match(rollback, new RegExp(`EXISTS \\(SELECT 1 FROM ${name}\\)`));
  }
  assert.match(rollback, /precos_adicional WHERE valor = 0/);
  assert.match(rollback, /rollback automático recusado/);
  assert.match(rollback, /ADD CONSTRAINT precos_adicional_valor_check CHECK \(valor > 0\)/);
});
