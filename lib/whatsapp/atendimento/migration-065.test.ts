import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

// Leitura estática dos arquivos da 065 (nenhum banco é acessado). A aplicação real exige autorização explícita.
const up = readFileSync('database/migrations/20261004_065_whatsapp_nome_perfil.sql', 'utf8');
const down = readFileSync('database/rollback/20261004_065_whatsapp_nome_perfil_down.sql', 'utf8');
const post = readFileSync('database/checks/20261004_065_postcheck.sql', 'utf8');
const postDown = readFileSync('database/checks/20261004_065_rollback_postcheck.sql', 'utf8');
const semComentarios = (sql: string) => sql.replace(/--.*$/gm, '');

test('065 é aditiva: duas colunas anuláveis na conversa da 060, sem DML, falha fechada', () => {
  const sql = semComentarios(up);
  assert.match(sql, /^BEGIN;[\s\S]*COMMIT;\s*$/m); assert.match(sql, /SET LOCAL lock_timeout = '5s'/);
  assert.deepEqual([...sql.matchAll(/ALTER TABLE (\w+)/g)].map(m => m[1]), ['whatsapp_atendimento_conversas'], 'só a tabela de conversas');
  assert.deepEqual([...sql.matchAll(/ADD COLUMN (\w+)/g)].map(m => m[1]), ['nome_perfil', 'nome_perfil_em']);
  assert.doesNotMatch(sql, /NOT NULL|DEFAULT/, 'anuláveis e sem default: sem reescrita nem preenchimento');
  assert.doesNotMatch(sql, /\b(DROP\s+\w+|TRUNCATE|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|CREATE\s+TABLE)\b/i, 'nenhum DML nem objeto removido');
  assert.match(sql, /RAISE EXCEPTION '065 exige a 060/); assert.match(sql, /RAISE EXCEPTION '065 já aplicada/);
  assert.match(sql, /char_length\(nome_perfil\) BETWEEN 1 AND 80/, 'mesmo limite do saneamento (NOME_PERFIL_MAX)');
  assert.match(sql, /CHECK \(\(nome_perfil IS NULL\) = \(nome_perfil_em IS NULL\)\)/);
  assert.match(up, /NÃO verificado/, 'a natureza do dado fica documentada no próprio banco');
  assert.doesNotMatch(sql, /mensagens_prontas/, 'independe da 064');
});

test('rollback da 065 só remove as colunas dela e exige decisão explícita com nomes gravados', () => {
  const sql = semComentarios(down);
  assert.match(sql, /LOCK TABLE whatsapp_atendimento_conversas IN ACCESS EXCLUSIVE MODE/);
  assert.match(sql, /kidmais\.rollback_065_descartar_nomes/);
  assert.deepEqual([...sql.matchAll(/DROP COLUMN (\w+)/g)].map(m => m[1]).sort(), ['nome_perfil', 'nome_perfil_em']);
  assert.doesNotMatch(sql, /DROP TABLE|whatsapp_atendimento_mensagens_prontas/, 'não remove tabela nem toca a 064');
});

test('postchecks da 065 são somente leitura', () => {
  for (const [nome, texto] of [['postcheck', post], ['pós-rollback', postDown]] as const) {
    const sql = semComentarios(texto);
    assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE|GRANT)\b/i, nome);
  }
  assert.match(post, /SELECT '065 postcheck OK'/); assert.match(postDown, /SELECT '065 rollback postcheck OK'/);
  assert.match(post, /unicidade \(empresa, ambiente, contato\) da 060/, 'confere que o isolamento da 060 continua');
});

test('numeração coordenada: 063 reservada ao painel; 064 (prontas) e 065 (nome de perfil) únicas nesta branch', () => {
  const nums = readdirSync('database/migrations').map(f => f.split('_')[1]).filter(n => /^\d{3}$/.test(n ?? ''));
  assert.equal(nums.filter(n => n === '064').length, 1); assert.equal(nums.filter(n => n === '065').length, 1);
  assert.ok(nums.includes('060'));
  // A 063 é da candidata feat/painel-desenvolvedor-20261004 (já publicada): esta branch não pode usá-la.
  assert.ok(!nums.includes('063'), '063 reservada ao painel');
  for (const pasta of ['database/checks', 'database/rollback']) assert.ok(!readdirSync(pasta).some(f => f.startsWith('20261004_063_')), `sem arquivo 063 em ${pasta}`);
});
