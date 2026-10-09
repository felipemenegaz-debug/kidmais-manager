import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { ATALHOS, LIMITE_LEGENDA, TIPOS_077 as TIPOS, TIPOS_MIDIA } from './prontas.ts';
import { LIMITE_LEGENDA_ENVIO } from './service.ts';

// Leitura estática dos arquivos da 077 (nenhum banco é acessado). A aplicação real exige autorização explícita.
// Fim de linha normalizado: com core.autocrlf (checkout no Windows) os .sql chegam com CRLF; o conteúdo conferido é o
// mesmo do repositório (LF), então as verificações valem igual nos dois checkouts.
const ler = (arquivo: string) => readFileSync(arquivo, 'utf8').replace(/\r\n/g, '\n');
const up = ler('database/migrations/20261009_077_whatsapp_prontas_midia.sql');
const down = ler('database/rollback/20261009_077_whatsapp_prontas_midia_down.sql');
const post = ler('database/checks/20261009_077_postcheck.sql');
const postDown = ler('database/checks/20261009_077_rollback_postcheck.sql');
const semComentarios = (sql: string) => sql.replace(/--.*$/gm, '');
const lista = (sql: string, restricao: string) => [...(new RegExp(`${restricao} CHECK \\((\\w+) IN \\(([^)]*)\\)\\)`).exec(sql)?.[2] ?? '').matchAll(/'(\w+)'/g)].map(m => m[1]);

test('077 é aditiva: troca só as duas restrições da 076 e acrescenta colunas anuláveis, sem DML, falha fechada', () => {
  const sql = semComentarios(up);
  assert.match(sql, /^BEGIN;[\s\S]*COMMIT;\s*$/m); assert.match(sql, /SET LOCAL lock_timeout = '5s'/);
  assert.deepEqual([...sql.matchAll(/ALTER TABLE (\w+)/g)].map(m => m[1]), ['whatsapp_atendimento_mensagens_prontas', 'whatsapp_atendimento_mensagens']);
  assert.deepEqual([...sql.matchAll(/ADD COLUMN (\w+)/g)].map(m => m[1]), ['midia_url', 'midia_tipo', 'midia_url', 'midia_pronta_id', 'midia_pronta_versao']);
  const colunas = sql.split(/,\n|;\n/).filter(trecho => /ADD COLUMN/.test(trecho));
  assert.equal(colunas.length, 5);
  for (const trecho of colunas) assert.doesNotMatch(trecho.replace(/CHECK \([\s\S]*\)/, ''), /NOT NULL|DEFAULT/, 'anuláveis e sem default: sem reescrita nem preenchimento');
  assert.deepEqual([...sql.matchAll(/DROP CONSTRAINT (\w+)/g)].map(m => m[1]), ['whatsapp_atendimento_mensagens_prontas_tipo_check', 'whatsapp_atendimento_mensagens_prontas_atalho_check'], 'só as duas restrições substituídas');
  assert.doesNotMatch(sql, /\b(DROP\s+(TABLE|COLUMN|INDEX)|TRUNCATE|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|CREATE\s+TABLE)\b/i, 'nenhum DML nem objeto removido');
  assert.match(sql, /RAISE EXCEPTION '077 exige a 060 \(atendimento WhatsApp\) e a 076/); assert.match(sql, /RAISE EXCEPTION '077 já aplicada/);
  assert.match(sql, /attname IN \('midia_url', 'midia_tipo', 'midia_pronta_id', 'midia_pronta_versao'\)/, 'qualquer coluna da 077 já presente = já aplicada (total ou parcialmente)');
  assert.match(sql, /RAISE EXCEPTION '077 recusada: as restrições de tipo\/atalho da 076 divergem/, 'confere as restrições da 076 antes de trocá-las');
  assert.doesNotMatch(sql, /nome_perfil/, 'independe da 065');
});

test('origem da mídia: pronta + versão revisada, FK composta (mesma empresa/ambiente) que torna a 076 dependente da 077', () => {
  const sql = semComentarios(up);
  assert.match(sql, /ADD CONSTRAINT whatsapp_mensagens_midia_pronta FOREIGN KEY \(midia_pronta_id, empresa_id, ambiente\)\s+REFERENCES whatsapp_atendimento_mensagens_prontas \(id, empresa_id, ambiente\);/);
  assert.doesNotMatch(sql, /ON DELETE (CASCADE|SET NULL)/, 'a origem não some nem é apagada em cascata');
  assert.match(sql, /whatsapp_mensagens_midia_origem CHECK \(\(midia_tipo IS NULL\) = \(midia_pronta_id IS NULL\) AND \(midia_pronta_id IS NULL\) = \(midia_pronta_versao IS NULL\)\)/);
  assert.match(sql, /whatsapp_mensagens_midia_pronta_versao CHECK \(midia_pronta_versao >= 0\)/);
  // A proteção depende de o down da 076 continuar SEM cascade: com a FK, o DROP TABLE dele falha fechado.
  const down076 = semComentarios(ler('database/rollback/20261009_076_whatsapp_mensagens_prontas_down.sql'));
  assert.match(down076, /DROP TABLE whatsapp_atendimento_mensagens_prontas;/);
  assert.doesNotMatch(down076, /CASCADE/);
  assert.match(post, /FOREIGN KEY \(midia_pronta_id, empresa_id, ambiente\) REFERENCES whatsapp_atendimento_mensagens_prontas\(id, empresa_id, ambiente\)/, 'o postcheck confere a FK exata');
});

test('listas e limites do banco iguais aos do código (tipos, atalhos, mídia, legenda)', () => {
  const sql = semComentarios(up);
  assert.deepEqual(lista(sql, 'whatsapp_prontas_tipo'), [...TIPOS]);
  assert.deepEqual(lista(sql, 'whatsapp_prontas_atalho'), [...ATALHOS]);
  assert.deepEqual(lista(sql, 'whatsapp_mensagens_midia_tipo'), [...TIPOS_MIDIA]);
  assert.equal(LIMITE_LEGENDA, 1024); assert.equal(LIMITE_LEGENDA_ENVIO, LIMITE_LEGENDA, 'cadastro e envio com o mesmo teto');
  assert.match(sql, /whatsapp_prontas_legenda_limite CHECK \(tipo NOT IN \('IMAGEM', 'VIDEO'\) OR length\(texto\) <= 1024\)/);
  assert.match(sql, /whatsapp_mensagens_legenda_limite CHECK \(midia_tipo IS NULL OR texto IS NULL OR length\(texto\) <= 1024\)/);
  assert.equal([...sql.matchAll(/midia_url ~ '\^https:\/\/\[\^\[:space:\]\]\+\$' AND length\(midia_url\) <= 2048/g)].length, 2, 'https e teto de 2048 nas duas tabelas');
  assert.match(sql, /whatsapp_prontas_midia_por_tipo CHECK \(\(tipo IN \('IMAGEM', 'VIDEO'\)\) = \(midia_url IS NOT NULL\)\)/);
  assert.match(sql, /whatsapp_mensagens_midia_so_saida CHECK \(midia_tipo IS NULL OR direcao = 'SAIDA'\)/);
});

test('rollback da 077: trava, recusa (fila; mídias enviadas e prontas de mídia sem decisão); ordem segura; devolve as restrições da 076', () => {
  const sql = semComentarios(down);
  assert.match(sql, /LOCK TABLE whatsapp_atendimento_mensagens_prontas_favoritas, whatsapp_atendimento_mensagens_prontas, whatsapp_atendimento_mensagens IN ACCESS EXCLUSIVE MODE/);
  assert.match(sql, /midia_tipo IS NOT NULL AND estado IN \('PENDENTE', 'PROCESSANDO', 'ENVIANDO'\)\) THEN\s+RAISE EXCEPTION '[^']*na fila de envio/, 'fila bloqueia antes (e independente) das decisões de descarte');
  assert.match(sql, /IF EXISTS \(SELECT 1 FROM whatsapp_atendimento_mensagens_prontas WHERE tipo IN \('IMAGEM', 'VIDEO'\) OR atalho IN \('SALGADOS', 'BOLOS', 'ENDERECO', 'LOCALIZACAO'\)\)\s+AND COALESCE\(current_setting\('kidmais.rollback_077_descartar_prontas_midia', true\), ''\) <> 'sim' THEN\s+RAISE EXCEPTION/, 'sem a decisão, recusa antes de qualquer remoção');
  assert.deepEqual([...sql.matchAll(/DROP COLUMN (\w+)/g)].map(m => m[1]), ['midia_pronta_versao', 'midia_pronta_id', 'midia_url', 'midia_tipo', 'midia_url']);
  // Ordem: recusas → mensagens (sai a FK) → remoção decidida das prontas de mídia/atalhos novos → restrições da 076.
  const ordem = ['na fila de envio', 'kidmais.rollback_077_descartar_midias', 'kidmais.rollback_077_descartar_prontas_midia', 'DROP CONSTRAINT whatsapp_mensagens_midia_pronta,',
    'DELETE FROM whatsapp_atendimento_mensagens_prontas_favoritas', "DELETE FROM whatsapp_atendimento_mensagens_prontas WHERE tipo IN ('IMAGEM', 'VIDEO')",
    'UPDATE whatsapp_atendimento_mensagens_prontas SET atalho = NULL', 'ADD CONSTRAINT whatsapp_atendimento_mensagens_prontas_tipo_check'];
  ordem.reduce((antes, trecho) => { const i = sql.indexOf(trecho); assert.ok(i > antes, `fora de ordem ou ausente: ${trecho}`); return i; }, -1);
  assert.match(sql, /ADD CONSTRAINT whatsapp_atendimento_mensagens_prontas_tipo_check CHECK \(tipo IN \('TEXTO', 'LINK', 'LINK_FECHAMENTO_INDIVIDUAL'\)\)/);
  assert.match(sql, /ADD CONSTRAINT whatsapp_atendimento_mensagens_prontas_atalho_check CHECK \(atalho IN \('TABELA_PRECOS', 'DISPONIBILIDADE_FECHAMENTO'\)\)/);
  assert.doesNotMatch(sql, /DROP TABLE|TRUNCATE|DELETE FROM whatsapp_atendimento_mensagens\s/, 'não remove tabela nem mensagens (só as prontas decididas)');
  // O caráter destrutivo fica declarado no topo do próprio script (o que apaga, o alcance global e o que fazer antes).
  assert.match(down, /\*\*\* DESTRUTIVO quando há dados de mídia/);
  assert.match(down, /de todas as empresas e\s+-- \*\*\* ambientes do banco/);
  assert.match(down, /Reaplicar a 077 depois NÃO recupera esses dados/);
});

test('postchecks da 077 são somente leitura', () => {
  for (const [nome, texto] of [['postcheck', post], ['pós-rollback', postDown]] as const) {
    const sql = semComentarios(texto);
    assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE|GRANT)\b/i, nome);
  }
  assert.match(post, /SELECT '077 postcheck OK'/); assert.match(postDown, /SELECT '077 rollback postcheck OK'/);
});

test('numeração: 077 única e só do atendimento', () => {
  const arquivos = readdirSync('database/migrations').filter(f => f.split('_')[1] === '077');
  assert.deepEqual(arquivos, ['20261009_077_whatsapp_prontas_midia.sql']);
});
