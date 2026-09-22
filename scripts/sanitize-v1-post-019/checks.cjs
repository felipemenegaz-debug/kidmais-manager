'use strict';

const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { hash, stable, refuse, exactKeys, PROFILE } = require('./guards.cjs');
const SOURCE_COMMIT = '0460d0a10ed0ba1afbd2061055762cf3913bda0b';
const MIGRATION_019 = '121265ed0e5c89882abf27a7178f206d26f0e1dea15a773bc413fdaf68ed4d90';
// Approved partition, not just its cardinalities. Changing a policy requires review.
const POLICY_SHA256 = '966a43921dd22fbeb043a00230ec164395fbda4b012b1f6d4b75386b906f608c';
const SOURCE_CHAIN_SHA256 = 'd7928066b0ed6df00eb8c61d988a04d978cde3f33fa6cbe2e7167430cfa50ba7';
const TECHNICAL = ['id', 'criado_em', 'atualizado_em'];
const REFERENCES = { pacote_id: 'pacotes', tabela_preco_id: 'tabelas_preco',
  configuracao_agenda_id: 'configuracao_agenda', adicional_id: 'adicionais' };
const CANONICALIZATION = 'V1_POST019_PG18_SEMANTIC_V1';
const PHYSICAL_SHA256 = '3b1066bc2bd546d589347561356490aaa19158026f31ea8893fd6c0db32d596e';
const PHYSICAL_CATALOG_SHA256 = 'f39fa1abc108a29470755a045d6d5cc60ce14c26da21a49861bbcf4bd2e99563';
const PHYSICAL_COMPONENTS_SHA256 = '3b602275f000caeed8f12dcefc2bbfff59ca2dc806b168806776068322cba757';
const PHYSICAL_COMPONENTS = ['acl', 'canonicalization', 'cluster_databases', 'columns', 'constraints',
  'database', 'default_privileges', 'descriptions', 'enums', 'extensions', 'functions', 'indexes',
  'memberships', 'relations', 'role_settings', 'roles', 'rules', 'schemas', 'sequences', 'server', 'triggers', 'types'];
// Literal seal authorities. Never learn these values from the files being checked.
const REFERENCE_RECIPE_SHA256 = '443ea6b6950d59a7546ea11b264847338c4369abd7a87a341c97696f12a6064b';
const REFERENCE_EXECUTOR_SHA256 = '31646a289dc1ebf3db13d4a620e3dabfb8e470ea79447f162e65dbe45f9baaf3';

function assertPolicy(policy) {
  exactKeys(policy, ['version', 'profile', 'tables'], 'POLICY_INVALID');
  const pairs = Object.entries(policy.tables || {});
  if (policy.version !== 1 || policy.profile !== PROFILE || pairs.length !== 63 ||
      pairs.filter(([, v]) => v === 'EMPTY').length !== 54 ||
      pairs.filter(([, v]) => v === 'PRESERVE_CANONICAL').length !== 9 ||
      pairs.some(([k, v]) => !/^[a-z][a-z0-9_]+$/.test(k) || !['EMPTY', 'PRESERVE_CANONICAL'].includes(v)) ||
      hash(stable(policy)) !== POLICY_SHA256) refuse('POLICY_INVALID');
}

function assertManifests({ policy, schema, catalog }) {
  assertPolicy(policy);
  if (!Array.isArray(schema.sources) || schema.sources.length !== 20 ||
      hash(stable(schema.sources.map(({ path, sha256 }) => ({ path, sha256 })))) !== SOURCE_CHAIN_SHA256 ||
      schema.sources.some(s => typeof s.sql !== 'string' || hash(s.sql) !== s.sha256)) refuse('SOURCE_MISMATCH');
  if (schema.source_commit !== SOURCE_COMMIT || catalog.source_commit !== SOURCE_COMMIT ||
      schema.migration_019_sha256 !== MIGRATION_019) refuse('MANIFEST_INVALID');
  const known = Object.fromEntries(Object.entries(schema.tables).map(([table, cols]) => [table, Object.keys(cols)]));
  assertInventory(known, schema, policy);
  if (stable(Object.keys(catalog.tables).sort()) !== stable(Object.keys(policy.tables).filter(t => policy.tables[t] === 'PRESERVE_CANONICAL').sort())) refuse('MANIFEST_INVALID');
  for (const [table, rows] of Object.entries(catalog.tables)) {
    if (!Array.isArray(rows) || !rows.length) refuse('MANIFEST_INVALID');
    const columns = Object.keys(schema.tables[table]).filter(c => !TECHNICAL.includes(c));
    for (const row of rows) exactKeys(row, columns, 'MANIFEST_INVALID');
  }
  const logical = deriveSchema(schema.sources);
  if (stable({ ...schema, physical_projection: null, execution_gate: logical.execution_gate }) !== stable(logical) ||
      stable(deriveCatalog(schema.sources, logical)) !== stable(catalog)) refuse('MANIFEST_INVALID');
}

// Narrow SQL source scanner, NOT an SQL executor or general PostgreSQL parser.
// Splits only outside strings, comments, dollar bodies and nested parentheses.
function splitSQL(text, separator = ';') {
  const result = []; let token = ''; let depth = 0; let quote = false; let dollar = null;
  for (let i = 0; i < text.length; i++) {
    if (dollar) { if (text.startsWith(dollar, i)) { token += dollar; i += dollar.length - 1; dollar = null; } else token += text[i]; continue; }
    if (quote) { token += text[i]; if (text[i] === "'") { if (text[i + 1] === "'") token += text[++i]; else quote = false; } continue; }
    if (text.startsWith('--', i)) { const end = text.indexOf('\n', i); i = end < 0 ? text.length : end; token += ' '; continue; }
    if (text.startsWith('/*', i)) { const end = text.indexOf('*/', i + 2); if (end < 0) refuse('SOURCE_MISMATCH'); i = end + 1; token += ' '; continue; }
    const tag = text.slice(i).match(/^\$[a-zA-Z_0-9]*\$/);
    if (tag) { dollar = tag[0]; token += dollar; i += dollar.length - 1; continue; }
    if (text[i] === "'") quote = true;
    if (text[i] === '(') depth++;
    if (text[i] === ')') depth--;
    if (text[i] === separator && depth === 0) { if (token.trim()) result.push(token.trim()); token = ''; } else token += text[i];
  }
  if (quote || dollar || depth !== 0) refuse('SOURCE_MISMATCH');
  if (token.trim()) result.push(token.trim());
  return result;
}
function literal(input) {
  const s = input.trim().replace(/::(?:numeric|smallint|integer|text)\b/g, '').replace(/^DATE\s+/i, '');
  if (/^null$/i.test(s)) return null;
  if (/^(true|false)$/i.test(s)) return s.toLowerCase() === 'true';
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (/^'(?:[^']|'')*'$/.test(s)) return s.slice(1, -1).replace(/''/g, "'");
  refuse('SOURCE_MISMATCH');
}
function rowsFromValues(text) {
  return splitSQL(text.trim(), ',').map(row => {
    if (!row.startsWith('(') || !row.endsWith(')')) refuse('SOURCE_MISMATCH');
    return splitSQL(row.slice(1, -1), ',').map(literal);
  });
}
function inserts(sql, table) {
  return splitSQL(sql).filter(s => new RegExp(`INSERT INTO ${table} \\(`, 'i').test(s)).map(statement => {
    const m = statement.match(new RegExp(`INSERT INTO ${table} \\(([\\s\\S]*?)\\)\\s*([\\s\\S]*)`, 'i'));
    return { statement, columns: m[1].split(',').map(s => s.trim()), query: m[2].trim() };
  });
}
function deriveSchema(sources) {
  const tables = {}; const declarations = []; const functions = {};
  for (const source of sources) {
    for (const [statementIndex, statement] of splitSQL(source.sql).entries()) {
      const create = statement.match(/^CREATE TABLE (?:IF NOT EXISTS )?(?:public\.)?(\w+)\s*\(([\s\S]*)\)$/i);
      if (create) {
        if (tables[create[1]]) refuse('SOURCE_MISMATCH');
        const columns = {};
        for (const item of splitSQL(create[2], ',')) {
          if (/^(CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN|EXCLUDE)\b/i.test(item)) continue;
          const col = item.match(/^(\w+)\s+([\s\S]+)$/);
          if (!col || columns[col[1]]) refuse('SOURCE_MISMATCH');
          columns[col[1]] = col[2].replace(/\s+/g, ' ');
        }
        tables[create[1]] = columns;
      }
      const alter = statement.match(/^ALTER TABLE (?:public\.)?(\w+)\s+([\s\S]+)$/i);
      if (alter) {
        if (!tables[alter[1]]) refuse('SOURCE_MISMATCH');
        for (const action of splitSQL(alter[2], ',')) {
          const add = action.match(/^ADD COLUMN (\w+)\s+([\s\S]+)$/i);
          if (add) { if (tables[alter[1]][add[1]]) refuse('SOURCE_MISMATCH'); tables[alter[1]][add[1]] = add[2].replace(/\s+/g, ' '); }
          const nullable = action.match(/^ALTER COLUMN (\w+) DROP NOT NULL$/i);
          if (nullable) tables[alter[1]][nullable[1]] = tables[alter[1]][nullable[1]].replace(/\bNOT NULL\b/i, '').trim();
          if (/\b(DROP COLUMN|RENAME COLUMN|ALTER COLUMN .* TYPE)\b/i.test(action)) refuse('SOURCE_MISMATCH');
        }
      }
      if (/^(CREATE|ALTER|DROP|COMMENT)\b/i.test(statement) || /^DO\b/i.test(statement))
        declarations.push({ source: source.path, statement_index: statementIndex, sha256: hash(statement) });
      const fn = statement.match(/^CREATE(?: OR REPLACE)? FUNCTION (?:public\.)?(\w+)\s*\(([\s\S]*?)\)\s+([\s\S]*?)\bAS\s+(\$\w*\$)([\s\S]*)\4$/i);
      if (fn) functions[fn[1]] = { arguments_sql: fn[2], properties_sql: fn[3].trim(), body_sha256: hash(fn[5]), source: source.path };
    }
  }
  return { format_version: 1, source_commit: SOURCE_COMMIT, migration_019_sha256: MIGRATION_019,
    historical_identity: 'CANONICAL_BY_PHYSICAL_EQUIVALENCE_NOT_PROVEN_EXECUTED_BYTES',
    normalization: 'UTF8_LF_NO_BOM', sources: sources.map(s => ({ path: s.path, sha256: hash(s.sql), sql: s.sql })),
    tables, functions, declarations,
    physical_projection: null,
    execution_gate: 'B5B2_DISPOSABLE_NATIVE_PROJECTION_REVIEW_REQUIRED' };
}

function baseRow(schema, table) {
  return Object.fromEntries(Object.entries(schema.tables[table]).filter(([name]) => !TECHNICAL.includes(name)).map(([name, definition]) => {
    const def = definition.match(/\bDEFAULT\s+(true|false|\d+|'[^']*')(?=\s|$)/i);
    return [name, def ? literal(def[1]) : null];
  }));
}
function deriveCatalog(sources, schema) {
  const by = id => { const source = sources.find(s => s.path.includes(`_${id}_`)); if (!source) refuse('SOURCE_MISMATCH'); return source.sql; };
  const initial = by('005'); const commercial = by('006'); const patch = by('006a'); const friday = by('017');
  const result = {}; const provenance = [];
  const push = (table, values) => { const row = { ...baseRow(schema, table), ...values }; (result[table] ||= []).push(row); return row; };
  for (const [table, sql] of [['configuracao_agenda', initial], ['pacotes', commercial], ['adicionais', commercial], ['tabelas_preco', commercial]]) {
    const seed = inserts(sql, table); if (seed.length !== 1 || !seed[0].query.startsWith('VALUES')) refuse('SOURCE_MISMATCH');
    provenance.push(seed[0].statement);
    for (const values of rowsFromValues(seed[0].query.slice(6))) push(table, Object.fromEntries(seed[0].columns.map((col, i) => [col,
      table === 'configuracao_agenda' && col.startsWith('horario_') ? `${values[i]}:00` : values[i]])));
  }
  // The pinned INSERT SELECT expressions provide values/text; only the join/key mapping is interpreted here.
  for (const [table, sql] of [['precos_pacote', commercial], ['precos_pacote', patch], ['precos_adicional', commercial]]) {
    for (const seed of inserts(sql, table)) {
      provenance.push(seed.statement);
      const tuples = seed.statement.match(/FROM\s*\(VALUES([\s\S]*?)\)\s*AS v\(([^)]+)\)/i);
      const matrix = tuples ? rowsFromValues(tuples[1]).map(row => Object.fromEntries(tuples[2].split(',').map((col, i) => [col.trim(), row[i]]))) : [{}];
      const selection = seed.query.match(/^SELECT([\s\S]*?)\bFROM\b/i);
      if (!selection) refuse('SOURCE_MISMATCH');
      const exprs = splitSQL(selection[1], ',');
      const packageCode = seed.statement.match(/FROM pacotes WHERE codigo = '([^']+)'/i) || seed.statement.match(/FROM pacotes\s+WHERE codigo = '([^']+)'/i);
      const additionalCode = seed.statement.match(/FROM adicionais WHERE codigo = '([^']+)'/i);
      const tableCode = seed.statement.match(/FROM tabelas_preco\s+WHERE codigo = '([^']+)'/i)?.[1];
      if (!tableCode || exprs.length !== seed.columns.length) refuse('SOURCE_MISMATCH');
      for (const matrixRow of matrix) {
        const values = Object.fromEntries(seed.columns.map((col, i) => {
          const e = exprs[i].trim();
          if (e === 't.id') return [col, tableCode];
          if (e === 'p.id') return [col, matrixRow.pacote_codigo || packageCode?.[1]];
          if (e === 'a.id') return [col, matrixRow.adicional_codigo || additionalCode?.[1]];
          if (/^[fv]\.\w+$/.test(e)) return [col, matrixRow[e.slice(2)]];
          return [col, literal(e)];
        }));
        if (Object.values(values).includes(undefined)) refuse('SOURCE_MISMATCH');
        push(table, values);
      }
    }
  }
  for (const statement of splitSQL(patch).filter(s => s.startsWith('UPDATE precos_pacote'))) {
    provenance.push(statement);
    const code = statement.match(/p\.codigo = '([^']+)'/)[1];
    const set = statement.match(/SET([\s\S]*?)FROM/)[1];
    const updates = Object.fromEntries(splitSQL(set, ',').map(pair => { const m = pair.match(/^\s*(\w+)\s*=\s*([\s\S]+)$/); return [m[1], literal(m[2])]; }));
    const rows = result.precos_pacote.filter(r => r.pacote_id === code); if (rows.length !== 1) refuse('SOURCE_MISMATCH'); Object.assign(rows[0], updates);
  }
  for (const table of ['regras_categoria_horario', 'regras_disponibilidade_pacote', 'regras_desconto_pacote']) {
    const seed = inserts(commercial, table)[0]; provenance.push(seed.statement);
    const selected = splitSQL(seed.query.match(/^SELECT([\s\S]*?)\bFROM\b/i)[1], ',');
    const values = Object.fromEntries(seed.columns.flatMap((col, i) => { try { return [[col, literal(selected[i])]]; } catch { return []; } }));
    const days = seed.statement.match(/generate_series\((\d+), (\d+)\)/); if (!days) refuse('SOURCE_MISMATCH');
    for (let day = Number(days[1]); day <= Number(days[2]); day++) {
      if (table === 'regras_categoria_horario') for (const c of result.configuracao_agenda) push(table, { ...values, dia_semana: day, configuracao_agenda_id: c.codigo, categoria_horario: (day === 6 && c.codigo === 'TURNO_2') || (day === 7 && c.codigo === 'TURNO_1') ? 'NOBRE' : 'PADRAO' });
      if (table === 'regras_disponibilidade_pacote') for (const p of result.pacotes) for (const c of result.configuracao_agenda) {
        let state = 'DISPONIVEL';
        if (p.codigo === 'POCKET' && day > 4) state = 'INDISPONIVEL';
        if (p.codigo === 'MINI_FESTA' && !(day <= 4 || (day === 5 && c.codigo === 'TURNO_1'))) state = 'INDISPONIVEL';
        if (p.codigo === 'COMPACTA' && day === 6 && c.codigo === 'TURNO_2') state = 'INDISPONIVEL';
        if (p.codigo === 'PIZZA_PARTY') state = 'SOB_CONSULTA';
        push(table, { ...values, dia_semana: day, configuracao_agenda_id: c.codigo, pacote_id: p.codigo, estado: state });
      }
      if (table === 'regras_desconto_pacote') {
        const codes = seed.statement.match(/codigo IN \(([^)]+)\)/)[1].split(',').map(literal);
        for (const code of codes) push(table, { ...values, dia_semana: day, pacote_id: code });
      }
    }
  }
  provenance.push(friday);
  const historicalEnd = friday.match(/SET vigencia_fim = DATE '([^']+)'/)[1];
  const start = friday.match(/DATE '([^']+)', NULL, true/)[1];
  const note = friday.match(/DATE '[^']+', NULL, true,\s*('(?:[^']|'')*')/)[1];
  const historical = result.regras_disponibilidade_pacote.filter(r => r.pacote_id === 'POCKET' && r.dia_semana === 5 && r.configuracao_agenda_id === 'TURNO_1');
  if (historical.length !== 1) refuse('SOURCE_MISMATCH');
  historical[0].vigencia_fim = historicalEnd;
  push('regras_disponibilidade_pacote', { ...historical[0], estado: 'DISPONIVEL', vigencia_inicio: start, vigencia_fim: null, observacoes: literal(note) });
  for (const rows of Object.values(result)) rows.sort((a, b) => stable(a).localeCompare(stable(b), 'en'));
  return { format_version: 1, source_commit: SOURCE_COMMIT,
    source_sha256: Object.fromEntries(schema.sources.filter(s => /_(005|006|006a|017)_/.test(s.path)).map(s => [s.path, s.sha256])),
    derivation: 'PINNED_SQL_LITERAL_PROJECTION_AND_EXPLICIT_RELATIONAL_RULES_V1',
    seed_statements_sha256: provenance.map(hash),
    excluded_technical_columns: TECHNICAL, reference_keys: REFERENCES, tables: result };
}

function assertInventory(actual, schema, policy) {
  assertPolicy(policy);
  if (!actual || stable(Object.keys(actual).sort()) !== stable(Object.keys(policy.tables).sort()) ||
      stable(Object.keys(schema.tables).sort()) !== stable(Object.keys(policy.tables).sort())) refuse('SCHEMA_MISMATCH');
  for (const table of Object.keys(policy.tables)) {
    if (!Array.isArray(actual[table]) || stable([...actual[table]].sort()) !== stable(Object.keys(schema.tables[table]).sort())) refuse('SCHEMA_MISMATCH');
  }
}
function assertCatalog(actual, catalog) {
  exactKeys(actual, Object.keys(catalog.tables), 'CATALOG_MISMATCH');
  for (const [table, expected] of Object.entries(catalog.tables)) {
    if (!Array.isArray(actual[table]) || stable(actual[table].map(stable).sort()) !== stable(expected.map(stable).sort())) refuse('CATALOG_MISMATCH');
  }
}
function assertSealed(schema) {
  // Never accept a fingerprint learned from the destination as its own authority.
  const value = schema.physical_projection;
  const recipeSha256 = hash(readFileSync(join(__dirname, 'reference-bootstrap.json'), 'utf8').replace(/\r\n?/g, '\n'));
  const executorSha256 = hash(readFileSync(join(__dirname, '..', 'sanitize-v1-post-019.reference.ps1'), 'utf8').replace(/\r\n?/g, '\n'));
  if (schema.execution_gate !== 'REVIEWED_DISPOSABLE_PROJECTION' || !value ||
      Object.keys(value).sort().join('|') !== ['sha256', 'source_commit', 'postgresql_version_num', 'canonicalization', 'reference_recipe_sha256', 'reference_executor_sha256', 'catalog_sha256', 'component_sha256'].sort().join('|') ||
      value.sha256 !== PHYSICAL_SHA256 || value.source_commit !== SOURCE_COMMIT ||
      value.postgresql_version_num !== 180006 || value.canonicalization !== CANONICALIZATION ||
      recipeSha256 !== REFERENCE_RECIPE_SHA256 || executorSha256 !== REFERENCE_EXECUTOR_SHA256 ||
      value.reference_recipe_sha256 !== REFERENCE_RECIPE_SHA256 || value.reference_executor_sha256 !== REFERENCE_EXECUTOR_SHA256 || value.catalog_sha256 !== PHYSICAL_CATALOG_SHA256 ||
      !value.component_sha256 || Object.keys(value.component_sha256).sort().join('|') !== [...PHYSICAL_COMPONENTS].sort().join('|') ||
      Object.values(value.component_sha256).some(v => !/^[a-f0-9]{64}$/.test(v)) ||
      hash(stable(value.component_sha256)) !== PHYSICAL_COMPONENTS_SHA256) refuse('BASELINE_UNSEALED');
}
function assertSnapshot(snapshot, schema, catalog, policy, post = false, before = null) {
  exactKeys(snapshot, ['inventory', 'catalog', 'counts', 'structure_sha256', 'catalog_identity_sha256', 'hazards', 'sequence_states'], 'POSTCHECK_FAILED');
  assertInventory(snapshot.inventory, schema, policy);
  assertCatalog(snapshot.catalog, catalog);
  exactKeys(snapshot.counts, Object.keys(policy.tables), 'POSTCHECK_FAILED');
  if (Object.values(snapshot.counts).some(v => !Number.isSafeInteger(v) || v < 0) ||
      snapshot.hazards !== 0 || snapshot.structure_sha256 !== schema.physical_projection.sha256 ||
      !/^[a-f0-9]{64}$/.test(snapshot.catalog_identity_sha256)) refuse('POSTCHECK_FAILED');
  for (const [table, rule] of Object.entries(policy.tables)) {
    if (rule === 'PRESERVE_CANONICAL' && snapshot.counts[table] !== catalog.tables[table].length) refuse('POSTCHECK_FAILED');
    if (post && rule === 'EMPTY' && snapshot.counts[table] !== 0) refuse('POSTCHECK_FAILED');
  }
  exactKeys(snapshot.sequence_states, ['festa_contagens_convidados_sequencia_seq', 'festa_eventos_sequencia_seq'], 'POSTCHECK_FAILED');
  if (Object.values(snapshot.sequence_states).some(s => !s || !Number.isSafeInteger(s.value) || typeof s.called !== 'boolean')) refuse('POSTCHECK_FAILED');
  if (before && (snapshot.catalog_identity_sha256 !== before.catalog_identity_sha256 || snapshot.structure_sha256 !== before.structure_sha256 ||
      stable(snapshot.sequence_states) !== stable(before.sequence_states))) refuse('POSTCHECK_FAILED');
}
module.exports = { SOURCE_COMMIT, MIGRATION_019, TECHNICAL, REFERENCES, assertPolicy, assertManifests, splitSQL,
  literal, deriveSchema, deriveCatalog, assertInventory, assertCatalog, assertSealed, assertSnapshot };
