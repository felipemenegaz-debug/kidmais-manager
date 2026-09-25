import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync('database/migrations/20260925_026_perfil_empresa_estrutura.sql', 'utf8');
const sql = migration.replace(/--.*$/gm, '');
const precheck = readFileSync('database/checks/20260925_026_precheck.sql', 'utf8');
const postcheck = readFileSync('database/checks/20260925_026_postcheck.sql', 'utf8');
const precos = readFileSync('app/api/admin/configuracoes/tabela-pacotes/route.ts', 'utf8');
const revisao = readFileSync('docs/modulos/PERFIL-EMPRESA-MIGRATION-026.md', 'utf8');

test('migration cria só as três tabelas vazias, sem seed, BYTEA ou trigger', () => {
  assert.deepEqual([...migration.matchAll(/CREATE TABLE ([a-z_]+)/g)].map((match) => match[1]), [
    'perfil_empresas',
    'perfil_unidades',
    'perfil_empresa_concessoes',
  ]);
  assert.doesNotMatch(sql, /^\s*(INSERT|UPDATE|DELETE|TRUNCATE|COPY)\b/im);
  assert.doesNotMatch(sql, /bytea|CREATE TRIGGER|singleton/i);
  assert.doesNotMatch(migration, /ALTER TABLE usuarios_administrativos/);
});

test('concessão liga empresa e usuário, com CHECK de linha e índice parcial', () => {
  assert.match(migration, /REFERENCES perfil_empresas \(id\) ON DELETE RESTRICT ON UPDATE RESTRICT/);
  assert.match(migration, /REFERENCES usuarios_administrativos \(id\) ON DELETE RESTRICT ON UPDATE RESTRICT/);
  assert.match(migration, /PERFIL_CONSULTAR/);
  assert.match(migration, /PERFIL_EDITAR_RASCUNHO/);
  assert.match(migration, /PERFIL_APLICAR/);
  assert.match(migration, /PERFIL_ADMINISTRAR_CONCESSOES/);
  assert.match(migration, /revogado_por IS NULL AND revogado_em IS NULL AND motivo_revogacao IS NULL/);
  assert.match(migration, /ON perfil_empresa_concessoes \(empresa_id, usuario_id, capacidade\)\s+WHERE revogado_em IS NULL/);
});

test('zero linhas é postcheck de instalação inicial e não se reutiliza depois', () => {
  assert.match(migration, /instalação inicial/i);
  assert.match(migration, /Não reexecutar após o provisionamento/);
  assert.match(postcheck, /Não reutilizar após o provisionamento/);
  assert.match(postcheck, /zero linhas vale só na instalação inicial/);
  assert.match(precheck, /estruturas já existem/);
});

test('revogação preenchida exige motivo não nulo no texto; isso não prova o PostgreSQL', () => {
  // Esta asserção só recusa a omissão textual de motivo_revogacao IS NOT NULL.
  // Não executa o CHECK e não substitui o teste futuro no PostgreSQL.
  const check = migration.slice(migration.indexOf('perfil_empresa_concessoes_revogacao_check'));
  assert.match(check, /revogado_por IS NULL AND revogado_em IS NULL AND motivo_revogacao IS NULL/);
  assert.match(
    check,
    /revogado_por IS NOT NULL\s+AND revogado_em IS NOT NULL\s+AND motivo_revogacao IS NOT NULL\s+AND length\(btrim\(motivo_revogacao\)\) >= 3/,
  );
  assert.match(postcheck, /motivo_revogacao IS NOT NULL/);
  assert.match(postcheck, /'public\.perfil_empresa_concessoes'::regclass/);
  assert.match(postcheck, /ARRAY\['empresa_id', 'usuario_id', 'capacidade'\]/);
  assert.match(precheck, /'public\.festa_usuario_capacidades'::regclass/);
  assert.match(revisao, /não substitui o teste futuro no PostgreSQL/);
});

test('preços atuais e limites de revisão permanecem explícitos', () => {
  assert.match(precos, /sessao\.papel !== 'REPRESENTANTE_AUTORIZADO'/);
  assert.match(revisao, /Nenhuma concessão poderá ocorrer antes/);
  assert.match(revisao, /trava estável antes da criação da primeira empresa/);
  assert.match(revisao, /permissões atuais de preços permanecem/);
  assert.match(revisao, /não comprova execução ou concorrência/);
});
