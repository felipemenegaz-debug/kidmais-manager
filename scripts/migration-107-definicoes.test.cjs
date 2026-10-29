/* eslint-disable @typescript-eslint/no-require-imports */
// E4-A, sem banco: constantes da 107 (14 objetos, nomes únicos, mesmo VALUES da migration, estrutura do gatilho e corte
// do índice iguais aos da migration), construtores SOMENTE LEITURA (nenhuma palavra de escrita fora de literal) e o check
// versionado 20261029_107_integridade.sql igual ao gerado. A confirmação das constantes no servidor é do cluster PG 18.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const {spawnSync} = require('node:child_process');
const m = require('./migration-107-definicoes.cjs');
const gerar = require('./gerar-107-integridade.cjs');

const root = path.resolve(__dirname, '..');
const ler = (a) => fs.readFileSync(path.join(root, a), 'utf8');
const MIG = 'database/migrations/20261028_107_reparo_deriva_agenda.sql';

/** Remove literais ('…' com '' escapado), identificadores entre aspas e comentários de um SQL. */
function semLiterais(sql) {
  let s = '', i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "'") { i++; while (i < sql.length) { if (sql[i] === "'" && sql[i + 1] === "'") i += 2; else if (sql[i] === "'") { i++; break; } else i++; } s += "''"; continue; }
    if (c === '"') { i++; while (i < sql.length && sql[i] !== '"') i++; i++; s += '""'; continue; }
    if (c === '-' && sql[i + 1] === '-') { while (i < sql.length && sql[i] !== '\n') i++; continue; }
    if (c === '/' && sql[i + 1] === '*') { const f = sql.indexOf('*/', i + 2); i = f < 0 ? sql.length : f + 2; continue; }
    s += c; i++;
  }
  return s;
}
const ESCRITA = /\b(CREATE|ALTER|INSERT|UPDATE|DELETE|DROP|TRUNCATE|MERGE|GRANT|REVOKE|COPY|TEMP|TEMPORARY|SET|RESET|LOCK|CALL|DO|EXECUTE|PERFORM|INTO|VACUUM|ANALYZE|REINDEX|CLUSTER|COMMENT|NOTIFY|LISTEN|PREPARE|DISCARD|REFRESH|SECURITY|nextval|setval|pg_advisory\w*|lo_\w+|dblink\w*|pg_terminate_backend|pg_cancel_backend|set_config)\b/i;

/** Tuplas do VALUES do laço da migration: números, 'texto' ('' escapado) e NULL. */
function valoresDaMigration() {
  const sql = ler(MIG);
  const ini = sql.indexOf('FROM (VALUES'), fim = sql.indexOf(') AS v(n, tipo, tabela, canonico, deriva, expr)');
  assert.ok(ini > 0 && fim > ini, 'VALUES da migration localizado');
  const corpo = sql.slice(ini + 'FROM (VALUES'.length, fim);
  const tuplas = []; let atual = null, i = 0;
  while (i < corpo.length) {
    const c = corpo[i];
    if (c === "'") {
      let v = ''; i++;
      while (i < corpo.length) { if (corpo[i] === "'" && corpo[i + 1] === "'") { v += "'"; i += 2; } else if (corpo[i] === "'") { i++; break; } else v += corpo[i++]; }
      atual.push(v); continue;
    }
    if (c === '(' && atual === null) { atual = []; i++; continue; }
    if (c === ')' && atual !== null) { tuplas.push(atual); atual = null; i++; continue; }
    if (atual !== null && /\d/.test(c)) { const n = /^\d+/.exec(corpo.slice(i))[0]; atual.push(Number(n)); i += n.length; continue; }
    if (atual !== null && corpo.startsWith('NULL', i)) { atual.push(null); i += 4; continue; }
    i++;
  }
  return tuplas;
}

test('constantes: 14 objetos (3 I, 6 K, 3 N, 2 T), nomes únicos, ordem 1..14, PG 18', () => {
  assert.equal(m.PG_MAIOR, 18);
  assert.equal(m.DEFINICOES.length, 14);
  assert.deepEqual(m.DEFINICOES.map((d) => d.n), Array.from({length: 14}, (_, k) => k + 1));
  const conta = (t) => m.DEFINICOES.filter((d) => d.tipo === t).length;
  assert.deepEqual([conta('I'), conta('K'), conta('N'), conta('T')], [3, 6, 3, 2]);
  const nomes = m.DEFINICOES.flatMap((d) => [d.canonico, d.deriva]).filter((x) => x !== null);
  assert.equal(new Set(nomes).size, nomes.length, 'nomes canônicos e de deriva únicos');
  assert.equal(nomes.length, 14 + 9);
  for (const d of m.DEFINICOES) {
    assert.ok(['bloqueios_agenda', 'configuracao_agenda'].includes(d.tabela));
    assert.match(d.canonico, /^[a-z0-9_]+$/);
    assert.equal(d.deriva === null, d.tipo === 'N' || d.tipo === 'T', `${d.canonico}: deriva só para I/K`);
    if (d.tipo === 'I') { assert.match(d.esperado, /^USING btree \(.+\) WHERE \(.+\)$/); assert.ok(d.deriva.startsWith('ix_')); }
    if (d.tipo === 'K' || d.tipo === 'N') assert.match(d.esperado, /^CHECK \(\(.+\)\)$/);
    if (d.tipo === 'K') assert.ok(d.deriva.startsWith('ck_'));
    if (d.tipo === 'T') assert.equal(d.esperado, m.GATILHO_ESTRUTURA);
    assert.ok(Object.isFrozen(d));
  }
  assert.ok(Object.isFrozen(m.DEFINICOES));
});

test('estrutura do gatilho: 19|kidmais_set_atualizado_em()|0|true|0|O, igual ao modelo da migration e do down', () => {
  assert.equal(m.GATILHO_ESTRUTURA, '19|kidmais_set_atualizado_em()|0|true|0|O');
  assert.ok(ler(MIG).includes(`modelo := '${m.GATILHO_ESTRUTURA}';`));
  const [tgtype] = m.GATILHO_ESTRUTURA.split('|');
  // TRIGGER_TYPE_ROW (1) | TRIGGER_TYPE_BEFORE (2) | TRIGGER_TYPE_UPDATE (16)
  assert.equal(Number(tgtype), 1 | 2 | 16);
  // O down compara a mesma forma estrutural.
  assert.ok(ler('database/rollback/20261028_107_reparo_deriva_agenda_down.sql').includes("|| '|' || t.tgenabled::text"));
});

test('corte do índice igual ao da migration e do down', () => {
  assert.equal(m.RE_INDICE, '^CREATE INDEX \\S+ ON \\S+ ');
  assert.ok(ler(MIG).includes(`'${m.RE_INDICE}'`));
  assert.ok(ler('database/rollback/20261028_107_reparo_deriva_agenda_down.sql').includes(`'${m.RE_INDICE}'`));
});

test('definições = VALUES da migration (n, tipo, tabela, canônico, deriva, expressão)', () => {
  const tuplas = valoresDaMigration();
  assert.equal(tuplas.length, 14);
  assert.deepEqual(tuplas, m.DEFINICOES.map((d) => [d.n, d.tipo, d.tabela, d.canonico, d.deriva, d.expr]));
});

test('nomes canônicos e de deriva = os do postcheck da migration e os da 005', () => {
  const pos = ler('database/checks/20261028_107_postcheck.sql');
  for (const d of m.DEFINICOES) {
    assert.ok(pos.includes(`'${d.canonico}'`), `${d.canonico} no postcheck`);
    if (d.tipo === 'I') assert.ok(pos.includes(`'${d.deriva}'`), `${d.deriva} no postcheck`);
  }
  const base = ler('database/migrations/20260907_005_disponibilidade_base.sql');
  for (const d of m.DEFINICOES) assert.match(base, new RegExp(`\\b${d.canonico}\\b`), `${d.canonico} na 005`);
});

test('ações por tipo e registro: iguais ao que a migration grava/cria', () => {
  const sql = ler(MIG);
  for (const a of Object.values(m.ACAO_POR_TIPO)) assert.ok(sql.includes(`'${a}'`));
  assert.ok(sql.includes("CHECK (acao IN ('RENOMEAR_INDICE', 'RENOMEAR_CHECK', 'CRIAR_GATILHO', 'CRIAR_CHECK'))"));
  assert.ok(sql.includes("CHECK (tabela IN ('bloqueios_agenda', 'configuracao_agenda'))"));
  assert.ok(sql.includes("CHECK ((acao LIKE 'RENOMEAR_%') = (nome_anterior IS NOT NULL))"));
  assert.deepEqual(m.REGISTRO_COLUNAS.split(', ').map((c) => c.split(' ')[0]),
    ['ordem', 'acao', 'tabela', 'nome_anterior', 'nome_novo', 'definicao', 'registrado_em']);
  assert.equal(m.REGISTRO_RESTRICOES.length, 4);
  assert.deepEqual([...m.REGISTRO_RESTRICOES], [...m.REGISTRO_RESTRICOES].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)), 'ordem COLLATE "C"');
});

test('proveniência: só os 3 nao_vazio e o registro estão A CONFIRMAR no cluster; índices/CHECKs renomeados medidos no staging', () => {
  for (const d of m.DEFINICOES) {
    const esperada = d.tipo === 'N' ? m.ORIGEM_LOCAL_097 : d.tipo === 'T' ? m.ORIGEM_MIGRATION : m.ORIGEM_STAGING;
    assert.equal(d.origem, esperada, d.canonico);
  }
  assert.equal(m.A_CONFIRMAR_NO_CLUSTER.length, 3 + 1 + 4);
});

test('construtores somente leitura: nenhuma palavra de escrita fora de literal; um único SELECT (WITH)', () => {
  for (const [nome, sql] of [['sqlAvaliacao107', m.sqlAvaliacao107()], ['sqlIntegridade107', m.sqlIntegridade107()]]) {
    const limpo = semLiterais(sql);
    assert.doesNotMatch(limpo, ESCRITA, nome);
    assert.ok(!limpo.includes(';'), `${nome}: uma só instrução`);
    assert.match(sql, /^WITH\n/, nome);
    assert.ok(!sql.includes('$$'), nome);
    // Nenhum ::regclass de objeto que pode faltar (só to_regclass/to_regprocedure); regnamespace só de public.
    assert.doesNotMatch(limpo, /::regclass\b/, nome);
    assert.equal(m.sqlAvaliacao107(), m.sqlAvaliacao107(), 'determinístico');
  }
  // Os SELECTs dinâmicos (query_to_xml) também são só leitura.
  assert.doesNotMatch(m.SQL_REGISTRO_LEITURA, ESCRITA);
  assert.match(m.SQL_REGISTRO_LEITURA, /^SELECT /);
  for (const d of m.DEFINICOES.filter((x) => x.expr !== null)) assert.doesNotMatch(semLiterais(d.expr), ESCRITA, d.canonico);
  // O filtro reconhece escrita (controle positivo do próprio teste).
  assert.match(semLiterais("SELECT 1; CREATE TEMP TABLE x ()"), ESCRITA);
  assert.doesNotMatch(semLiterais("SELECT 'DROP TABLE x' -- DELETE\n"), ESCRITA);
});

test('avaliação: mesmos estados e motivos documentados; integridade: grupos de verificação presentes', () => {
  const a = m.sqlAvaliacao107();
  for (const e of ['CANONICO', 'DERIVA', 'AUSENTE_CRIAVEL', 'RECUSA:PG_MAIOR', 'RECUSA:BASE_AUSENTE', 'RECUSA:GATILHO_OUTRO_NOME',
    'RECUSA:DOIS_NOMES', 'RECUSA:DEFINICAO_DIFERENTE', 'RECUSA:DEFINICAO_DIFERENTE_DERIVA', 'RECUSA:NOME_OCUPADO', 'RECUSA:LINHA_VIOLA', 'RECUSA:AUSENTE']) {
    assert.ok(a.includes(`'${e}'`), e);
  }
  for (const c of ['indisvalid AND i.indisready', 'c.convalidated AND NOT c.connoinherit', 'ja_aplicada', 'linhas_violam', "' [INVALIDO]'", "' [FORMA]'"]) assert.ok(a.includes(c), c);
  const s = m.sqlIntegridade107();
  for (const c of ['i.indislive', 'NOT i.indisunique', 't.tgconstraint = 0', "c.contype <> 'n'", 'XMLTABLE', 'repeticoes = 1', 'n_anterior < r.n',
    m.lit(m.REGISTRO_COLUNAS), m.lit(m.REGISTRO_RESTRICOES.join(' | ')), "LIKE 'ck\\_bloqueios\\_agenda\\_%'"]) assert.ok(s.includes(c), c);
  for (const d of m.DEFINICOES) assert.ok(s.includes(m.lit(d.esperado)), d.canonico);
});

test('check versionado = gerado de sqlIntegridade107(); LF, com linha final; --conferir passa', () => {
  const versionado = fs.readFileSync(path.join(root, gerar.ARQUIVO));
  assert.equal(versionado.toString('utf8'), gerar.texto());
  assert.ok(!versionado.includes(Buffer.from('\r')), 'LF');
  assert.ok(versionado.toString('utf8').endsWith('END $$;\n'));
  assert.ok(versionado.toString('utf8').includes(m.sqlIntegridade107().split('\n').map((l) => (l ? '    ' + l : l)).join('\n')));
  assert.match(versionado.toString('utf8'), /RAISE EXCEPTION '107 integridade: %'/);
  // O arquivo só tem o invólucro DO/RAISE como "escrita" aparente: fora dele, nada.
  const corpo = semLiterais(versionado.toString('utf8')).replace(/\bDO \$\$/, '').replace(/\bEND \$\$;/, '');
  assert.doesNotMatch(corpo.replace(/\bINTO\b/g, ''), /\b(CREATE|ALTER|INSERT|UPDATE|DELETE|DROP|TRUNCATE|GRANT|REVOKE|COPY|TEMP|LOCK|EXECUTE)\b/i);
  const r = spawnSync(process.execPath, [path.join(__dirname, 'gerar-107-integridade.cjs'), '--conferir'], {encoding: 'utf8'});
  assert.equal(r.status, 0, r.stderr);
});

test('--conferir recusa arquivo divergente ou ausente (sem escrever)', () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'gerar-107-'));
  const alvo = path.join(dir, 'integridade.sql');
  const rodar = () => spawnSync(process.execPath, [path.join(__dirname, 'gerar-107-integridade.cjs'), '--conferir', '--arquivo', alvo], {encoding: 'utf8'});
  try {
    let r = rodar();
    assert.equal(r.status, 1); assert.match(r.stderr, /ausente/); assert.ok(!fs.existsSync(alvo), '--conferir não cria');
    const semFinal = gerar.texto().replace(/\n$/, '');
    fs.writeFileSync(alvo, semFinal);
    r = rodar();
    assert.equal(r.status, 1); assert.match(r.stderr, /difere do gerado/);
    assert.equal(fs.readFileSync(alvo, 'utf8'), semFinal, '--conferir não reescreve');
    fs.writeFileSync(alvo, gerar.texto().replace(/\n/g, '\r\n'));
    assert.equal(rodar().status, 1, 'CRLF difere');
    fs.writeFileSync(alvo, gerar.texto());
    assert.equal(rodar().status, 0);
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});
