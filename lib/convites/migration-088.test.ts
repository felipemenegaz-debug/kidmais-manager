import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

// Contrato textual da 088, sem conectar a banco algum (a execução real fica na suíte PostgreSQL descartável).
const ler = (f: string) => readFileSync(f, 'utf8');
const UP = ler('database/migrations/20261021_088_convite_ia_autorizacoes.sql');
const PRE = ler('database/checks/20261021_088_precheck.sql');
const POST = ler('database/checks/20261021_088_postcheck.sql');
const DOWN = ler('database/rollback/20261021_088_convite_ia_autorizacoes_down.sql');

test('088 é aditiva: só cria a tabela, índices e gatilho próprios; não altera dados nem tabelas existentes', () => {
  assert.match(UP, /^BEGIN;$/m); assert.match(UP, /^COMMIT;$/m);
  assert.match(UP, /SET LOCAL lock_timeout = '5s';/);
  assert.match(UP, /088: precheck falhou/);
  assert.doesNotMatch(UP, /ALTER TABLE (?!convite_ia_autorizacoes)/);
  assert.doesNotMatch(UP, /\bUPDATE\s+(?!convite_ia_autorizacoes)\w+\s+SET/i);
  assert.doesNotMatch(UP, /\bDELETE\s+FROM/i); assert.doesNotMatch(UP, /\bINSERT\s+INTO/i);
  assert.doesNotMatch(UP, /DROP /);
  // Sem cópia de documento: nenhuma coluna de CPF, RG ou arquivo.
  assert.doesNotMatch(UP.slice(UP.indexOf('CREATE TABLE convite_ia_autorizacoes'), UP.indexOf('CREATE UNIQUE INDEX')), /\b(cpf|rg|documento|arquivo|bytea)\b/i);
});

test('088 amarra a autorização ao convite e à empresa e registra os campos pedidos pela Astra', () => {
  assert.match(UP, /FOREIGN KEY \(convite_id, empresa_id\) REFERENCES convites\(id, empresa_id\)/);
  for (const coluna of ['operador_tipo', 'operador_usuario_id', 'operador_cliente_id', 'responsavel_nome', 'responsavel_vinculo', 'meio', 'declaracao_responsavel',
    'festa_id', 'finalidade', 'provedor', 'texto_versao', 'texto_hash', 'criado_em', 'revogada_em', 'revogada_por', 'revogacao_motivo'])
    assert.match(UP, new RegExp(`\\n  ${coluna} `), coluna);
  assert.match(UP, /CHECK \(provedor IN \('openai','gemini'\)\)/);
  // P2-3 da revisão de 15aa937: a fotografia é confirmada por geração (evento IA_RESERVADA), não na autorização geral.
  assert.doesNotMatch(UP + POST, /foto_autorizada/);
  assert.match(UP, /CHECK \(declaracao_responsavel\)/);
  assert.match(UP, /CREATE UNIQUE INDEX convite_ia_autorizacao_vigente ON convite_ia_autorizacoes\(convite_id\) WHERE revogada_em IS NULL/);
  assert.match(UP, /m\.status = 'ATIVA'/); assert.match(UP, /registro imutável/);
  assert.match(UP, /BEFORE INSERT OR UPDATE ON convite_ia_autorizacoes/);
  assert.doesNotMatch(UP, /BEFORE[^;]*DELETE/, 'exclusão segue a política de retenção; não é bloqueada por gatilho');
});

test('088: precheck e postcheck são somente leitura; rollback recusa com dados', () => {
  for (const sql of [PRE, POST]) { assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE)\b/); assert.doesNotMatch(sql, /BEGIN;|COMMIT;/); }
  assert.match(PRE, /088 precheck: aplicação anterior ou parcial encontrada/); assert.match(POST, /088 postcheck OK/);
  assert.match(DOWN, /LOCK TABLE convite_ia_autorizacoes IN ACCESS EXCLUSIVE MODE/);
  assert.match(DOWN, /IF EXISTS \(SELECT 1 FROM convite_ia_autorizacoes\)/);
  assert.match(DOWN, /088 rollback recusado/);
});
