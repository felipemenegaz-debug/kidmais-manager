import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

// Leitura estática dos arquivos da 064 (nenhum banco é acessado). A aplicação real exige autorização explícita.
const up = readFileSync('database/migrations/20261004_064_whatsapp_nome_perfil.sql', 'utf8');
const down = readFileSync('database/rollback/20261004_064_whatsapp_nome_perfil_down.sql', 'utf8');
const post = readFileSync('database/checks/20261004_064_postcheck.sql', 'utf8');
const postDown = readFileSync('database/checks/20261004_064_rollback_postcheck.sql', 'utf8');
const semComentarios = (sql: string) => sql.replace(/--.*$/gm, '');

test('064 é aditiva: duas colunas anuláveis na conversa da 060, sem DML, falha fechada', () => {
  const sql = semComentarios(up);
  assert.match(sql, /^BEGIN;[\s\S]*COMMIT;\s*$/m); assert.match(sql, /SET LOCAL lock_timeout = '5s'/);
  assert.deepEqual([...sql.matchAll(/ALTER TABLE (\w+)/g)].map(m => m[1]), ['whatsapp_atendimento_conversas'], 'só a tabela de conversas');
  assert.deepEqual([...sql.matchAll(/ADD COLUMN (\w+)/g)].map(m => m[1]), ['nome_perfil', 'nome_perfil_em']);
  assert.doesNotMatch(sql, /NOT NULL|DEFAULT/, 'anuláveis e sem default: sem reescrita nem preenchimento');
  assert.doesNotMatch(sql, /\b(DROP\s+\w+|TRUNCATE|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|CREATE\s+TABLE)\b/i, 'nenhum DML nem objeto removido');
  assert.match(sql, /RAISE EXCEPTION '064 exige a 060/); assert.match(sql, /RAISE EXCEPTION '064 já aplicada/);
  assert.match(sql, /char_length\(nome_perfil\) BETWEEN 1 AND 80/, 'mesmo limite do saneamento (NOME_PERFIL_MAX)');
  assert.match(sql, /CHECK \(\(nome_perfil IS NULL\) = \(nome_perfil_em IS NULL\)\)/);
  assert.match(up, /NÃO verificado/, 'a natureza do dado fica documentada no próprio banco');
  assert.doesNotMatch(sql, /mensagens_prontas/, 'independe da 063');
});

test('rollback da 064 só remove as colunas dela e exige decisão explícita com nomes gravados', () => {
  const sql = semComentarios(down);
  assert.match(sql, /LOCK TABLE whatsapp_atendimento_conversas IN ACCESS EXCLUSIVE MODE/);
  assert.match(sql, /kidmais\.rollback_064_descartar_nomes/);
  assert.deepEqual([...sql.matchAll(/DROP COLUMN (\w+)/g)].map(m => m[1]).sort(), ['nome_perfil', 'nome_perfil_em']);
  assert.doesNotMatch(sql, /DROP TABLE|whatsapp_atendimento_mensagens_prontas/, 'não remove tabela nem toca a 063');
});

test('postchecks da 064 são somente leitura', () => {
  for (const [nome, texto] of [['postcheck', post], ['pós-rollback', postDown]] as const) {
    const sql = semComentarios(texto);
    assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE|GRANT)\b/i, nome);
  }
  assert.match(post, /SELECT '064 postcheck OK'/); assert.match(postDown, /SELECT '064 rollback postcheck OK'/);
  assert.match(post, /unicidade \(empresa, ambiente, contato\) da 060/, 'confere que o isolamento da 060 continua');
});

test('numeração: 064 é única nesta branch e vem depois da 060 e da 063', () => {
  const nums = readdirSync('database/migrations').map(f => f.split('_')[1]).filter(n => /^\d{3}$/.test(n ?? ''));
  assert.equal(nums.filter(n => n === '064').length, 1);
  assert.ok(nums.includes('063') && nums.includes('060'));
});
