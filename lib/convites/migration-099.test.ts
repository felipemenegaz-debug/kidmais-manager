import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const up = readFileSync('database/migrations/20261024_099_convites_avulsos.sql', 'utf8');
const down = readFileSync('database/rollback/20261024_099_convites_avulsos_down.sql', 'utf8');
test('099 permite vínculo vazio ou completo, preserva unicidade de festa e não cria consumo', () => {
  assert.match(up, /festa_id IS NULL AND cliente_id IS NULL AND versao_contrato_id IS NULL/);
  assert.match(up, /festa_id IS NOT NULL AND cliente_id IS NOT NULL AND versao_contrato_id IS NOT NULL/);
  assert.match(up, /OLD\.festa_id IS NOT NULL/);
  assert.match(up, /NEW\.empresa_id IS DISTINCT FROM OLD\.empresa_id/);
  assert.match(up, /v\.contrato_id=c\.id/);
  assert.doesNotMatch(up, /DROP CONSTRAINT|INSERT INTO convite_consumos|UPDATE convites SET/i);
});
test('099 só muda a comparação nula da evidência 088; demais garantias ficam idênticas', () => {
  const old = readFileSync('database/migrations/20261021_088_convite_ia_autorizacoes.sql', 'utf8');
  const func = old.slice(old.indexOf('CREATE FUNCTION convite_ia_autorizacao_validar()'), old.indexOf('CREATE TRIGGER convite_ia_autorizacao_validar'))
    .replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION').replace('c.festa_id = NEW.festa_id', 'c.festa_id IS NOT DISTINCT FROM NEW.festa_id').replaceAll('\r\n', '\n').trim();
  assert.ok(up.replaceAll('\r\n', '\n').includes(func));
});
test('rollback 099 recusa perda de avulsos e autorizações antigas, sem deletar dados', () => {
  assert.match(down, /LOCK TABLE convites,convite_ia_autorizacoes IN ACCESS EXCLUSIVE MODE/);
  assert.match(down, /SELECT 1 FROM convites WHERE festa_id IS NULL/);
  assert.match(down, /SELECT 1 FROM convite_ia_autorizacoes WHERE festa_id IS NULL/);
  assert.doesNotMatch(down, /DELETE FROM|TRUNCATE/i);
});
