/* eslint-disable @typescript-eslint/no-require-imports */
// Verifica o contrato da migration isolada sem conectar ou alterar banco algum.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const root = path.resolve(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('migration 079 valida o schema de convites antes de expandir estados e guardar evidência auditável', () => {
  const base = read('database/migrations/20261008_073_convites.sql');
  const pre = read('database/checks/20261011_079_precheck.sql');
  const migration = read('database/migrations/20261011_079_convite_recuperacao_manual.sql');
  const post = read('database/checks/20261011_079_postcheck.sql');
  assert.match(base, /id uuid PRIMARY KEY, convite_id uuid NOT NULL, empresa_id uuid NOT NULL,[\s\S]*?payload_hash text NOT NULL,[\s\S]*?CHECK \(estado IN \('RESERVADA','CONCLUIDA','INCERTA'\)\)/);
  assert.match(pre, /convite_geracoes_estado_check/); assert.match(pre, /aplicação anterior ou parcial/);
  assert.match(migration, /RESOLVIDA_COBRADA/); assert.match(migration, /RESOLVIDA_SEM_COBRANCA/);
  for (const column of ['resolucao_resultado', 'resolucao_por', 'resolucao_em', 'resolucao_evidencia', 'reserva_microusd']) assert.match(migration, new RegExp(`ADD COLUMN ${column}`));
  assert.match(migration, /convite_geracoes_resolucao_consistente/); assert.match(post, /convite_geracoes_resolucao_consistente/);
  assert.match(migration, /resolucao_resultado IS NOT NULL AND resolucao_evidencia IS NOT NULL/);
  assert.match(post, /resolucao_resultado IS NOT NULL/); assert.match(post, /resolucao_evidencia IS NOT NULL/);
});

test('rollback 079 preserva histórico e só é possível antes de decisões', () => {
  const down = read('database/rollback/20261011_079_convite_recuperacao_manual_down.sql');
  assert.match(down, /ACCESS EXCLUSIVE MODE/);
  assert.match(down, /estado IN \('RESOLVIDA_COBRADA','RESOLVIDA_SEM_COBRANCA'\)/);
  assert.match(down, /rollback recusado/);
});

test('serviço identifica a geração por id e escopo completo; não consulta Gemini na recuperação', () => {
  const source = read('lib/convites/service.ts');
  assert.match(source, /WHERE id=\$1 AND convite_id=\$2 AND empresa_id=\$3 FOR UPDATE/);
  assert.match(source, /AND estado='INCERTA' RETURNING id/);
  assert.match(source, /IA_RECUPERACAO_MANUAL/);
  const body = source.slice(source.indexOf('async function recuperarGeracao'), source.indexOf('async function gerar'));
  assert.doesNotMatch(body, /gerarImagem|verificarComProvedor/);
});
