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
  assert.doesNotMatch(post, /WHERE estado IN \('RESOLVIDA_COBRADA','RESOLVIDA_SEM_COBRANCA'\)/,
    'postcheck permanece válido depois de decisões manuais legítimas');
});

test('rollback 079 preserva histórico e só é possível antes de decisões', () => {
  const down = read('database/rollback/20261011_079_convite_recuperacao_manual_down.sql');
  assert.match(down, /ACCESS EXCLUSIVE MODE/);
  assert.match(down, /estado IN \('RESOLVIDA_COBRADA','RESOLVIDA_SEM_COBRANCA'\)/);
  assert.match(down, /rollback recusado/);
});

test('decisão do operador identifica a geração por id, trava o convite e nunca chama o provedor', () => {
  const source = read('lib/convites/service.ts');
  const body = source.slice(source.indexOf('export async function resolverGeracaoIncerta'), source.indexOf('async function gerar('));
  assert.ok(body.includes("SELECT id FROM convites WHERE id=$1 FOR UPDATE"), "SELECT id FROM convites WHERE id=$1 FOR UPDATE");
  assert.ok(body.includes("WHERE id=$1 AND convite_id=$2 FOR UPDATE"), "WHERE id=$1 AND convite_id=$2 FOR UPDATE");
  assert.match(body, /AND estado='INCERTA' RETURNING id/);
  assert.match(body, /IA_RECUPERACAO_MANUAL/);
  assert.ok(!body.includes("gerarImagem"), "gerarImagem");
  assert.ok(!body.includes("gerarConviteCompletoOpenAI"), "gerarConviteCompletoOpenAI");
  assert.ok(!body.includes("fetch("), "fetch(");
  // A decisão saiu do editor: nenhum comando 'recuperar' no schema do convite nem no serviço.
  assert.ok(!read('lib/convites/domain.ts').includes("z.literal('recuperar')"), "z.literal('recuperar')");
  assert.doesNotMatch(source, /acao === 'recuperar'/);
});

test('migration 084 é aditiva, só relaxa estados para NAO_ENVIADA e amarra devolução automática a "sem envio"', () => {
  const pre = read('database/checks/20261018_084_precheck.sql');
  const migration = read('database/migrations/20261018_084_convite_geracao_pendencias.sql');
  const post = read('database/checks/20261018_084_postcheck.sql');
  const down = read('database/rollback/20261018_084_convite_geracao_pendencias_down.sql');
  for (const coluna of ['etapas_registradas', 'enviado_em', 'recebido_em', 'resultado_pendente', 'falha_classe', 'falha_diagnostico', 'falha_detalhes']) {
    assert.match(migration, new RegExp(`ADD COLUMN ${coluna} `)); assert.match(post, new RegExp(coluna)); assert.match(down, new RegExp(`DROP COLUMN ${coluna}`));
  }
  const semComentarios = migration.split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
  assert.doesNotMatch(semComentarios, /\bUPDATE\b|\bDELETE\b/, 'nenhuma linha existente é alterada');
  // Único padrão: linhas antigas e o código anterior ficam sem o marcador (nunca devolvidas automaticamente).
  assert.deepEqual(semComentarios.match(/NOT NULL DEFAULT \w+/g), ['NOT NULL DEFAULT false']);
  assert.ok(semComentarios.includes('ADD COLUMN etapas_registradas boolean NOT NULL DEFAULT false'));
  assert.match(migration, /'RESOLVIDA_SEM_COBRANCA','NAO_ENVIADA'/);
  for (const trecho of ["(estado = 'NAO_ENVIADA') = (falha_classe IS NOT DISTINCT FROM 'PRE_ENVIO')",
    "estado <> 'NAO_ENVIADA' OR (etapas_registradas AND enviado_em IS NULL AND recebido_em IS NULL AND resultado_pendente IS NULL)",
    'etapas_registradas OR (enviado_em IS NULL AND recebido_em IS NULL AND resultado_pendente IS NULL)', "'DEVOLUCAO_FALHOU'"])
    assert.ok(migration.includes(trecho), trecho);
  assert.match(pre, /aplicação anterior ou parcial/); assert.match(pre, /079 não está aplicada/);
  assert.match(down, /ACCESS EXCLUSIVE MODE/); assert.match(down, /rollback recusado/); assert.ok(down.includes("estado='NAO_ENVIADA' OR etapas_registradas OR enviado_em IS NOT NULL"));
  // O código novo grava o marcador explicitamente; só com ele o envio e a devolução automática acontecem.
  const servico = read('lib/convites/service.ts');
  assert.ok(servico.includes('payload_hash,modelo,etapas_registradas) VALUES($1,$2,$3,$4,$5,$6,true)'));
  assert.ok(servico.includes("WHERE id=$1 AND estado='RESERVADA' AND etapas_registradas AND enviado_em IS NULL RETURNING id\""), 'envio exige o marcador');
  assert.ok(servico.includes("WHERE id=$1 AND estado='RESERVADA' AND etapas_registradas AND enviado_em IS NULL RETURNING id`"), 'NAO_ENVIADA exige o marcador');
});
