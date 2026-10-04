import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Leitura estática dos arquivos da 063 (nenhum banco é acessado). A aplicação real exige autorização explícita.
const up = readFileSync('database/migrations/20261004_063_whatsapp_mensagens_prontas.sql', 'utf8');
const down = readFileSync('database/rollback/20261004_063_whatsapp_mensagens_prontas_down.sql', 'utf8');
const post = readFileSync('database/checks/20261004_063_postcheck.sql', 'utf8');
const semComentarios = (sql: string) => sql.replace(/--.*$/gm, '');

test('063 é aditiva: só cria as duas tabelas novas, não altera a 060 e falha fechada se já existir', () => {
  const sql = semComentarios(up);
  assert.match(sql, /^BEGIN;[\s\S]*COMMIT;\s*$/m); assert.match(sql, /SET LOCAL lock_timeout = '5s'/);
  assert.deepEqual([...sql.matchAll(/CREATE TABLE (\w+)/g)].map(m => m[1]), ['whatsapp_atendimento_mensagens_prontas', 'whatsapp_atendimento_mensagens_prontas_favoritas']);
  // "ON DELETE RESTRICT" de chave estrangeira não é DML; procura comandos.
  assert.doesNotMatch(sql, /\b(ALTER\s+TABLE|DROP\s+\w+|TRUNCATE|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/i, 'nenhuma alteração em objeto existente nem DML');
  assert.equal([...sql.matchAll(/ON DELETE (\w+)/g)].map(m => m[1]).join(), 'RESTRICT');
  assert.match(sql, /RAISE EXCEPTION '063 exige a 060/); assert.match(sql, /RAISE EXCEPTION '063 já aplicada/);
  assert.match(sql, /UNIQUE \(id, empresa_id, ambiente\)/);
  assert.match(sql, /FOREIGN KEY \(mensagem_pronta_id, empresa_id, ambiente\) REFERENCES whatsapp_atendimento_mensagens_prontas\(id, empresa_id, ambiente\)/, 'favorita presa à mesma empresa/ambiente');
  assert.match(sql, /CHECK \(\(tipo = 'LINK'\) = \(link IS NOT NULL\)\)/, 'link gravado só no tipo LINK; individual nunca gravado');
  assert.match(sql, /link ~ '\^https:\/\/\[\^\[:space:\]\]\+\$'/);
  assert.match(sql, /ON whatsapp_atendimento_mensagens_prontas \(empresa_id, ambiente, atalho\) WHERE atalho IS NOT NULL AND ativa/, 'um atalho ativo por empresa');
  assert.doesNotMatch(sql, /ON DELETE CASCADE/, 'remoção é lógica');
});

test('rollback da 063 só remove as tabelas dela e exige decisão explícita com dados gravados', () => {
  const sql = semComentarios(down);
  assert.deepEqual([...sql.matchAll(/DROP TABLE (\w+)/g)].map(m => m[1]), ['whatsapp_atendimento_mensagens_prontas_favoritas', 'whatsapp_atendimento_mensagens_prontas']);
  assert.match(sql, /LOCK TABLE [\s\S]* IN ACCESS EXCLUSIVE MODE/);
  assert.match(sql, /kidmais\.rollback_063_descartar_prontas/);
  assert.doesNotMatch(sql, /whatsapp_atendimento_(conversas|mensagens|config|status|auditoria)\b(?!_)/, 'não toca a 060');
});

test('postcheck da 063 é somente leitura', () => {
  const sql = semComentarios(post);
  assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE|GRANT)\b/i);
  assert.match(sql, /postcheck 063: favoritas sem chave composta/);
  assert.match(sql, /SELECT '063 postcheck OK'/);
});

test('pós-rollback da 063 é somente leitura e confere a 060 intacta', () => {
  const sql = semComentarios(readFileSync('database/checks/20261004_063_rollback_postcheck.sql', 'utf8'));
  assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE|GRANT)\b/i);
  assert.match(sql, /a 060 foi afetada/);
});
