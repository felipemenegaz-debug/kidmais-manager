'use strict';

// Offline-only structural gate. It does not connect to PostgreSQL or execute SQL.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const base = '20260923_020_saas_foundation';
const files = {
  up: `database/migrations/${base}.sql`,
  pre: `database/checks/${base}_precheck.sql`,
  post: `database/checks/${base}_postcheck.sql`,
  down: `database/rollback/${base}_down.sql`,
};
const sql = Object.fromEntries(Object.entries(files).map(([key, file]) =>
  [key, fs.readFileSync(path.join(root, file), 'utf8')]));
const tables = ['empresas', 'estabelecimentos', 'memberships', 'membership_estabelecimentos'];
const v1Tables = Object.keys(JSON.parse(fs.readFileSync(
  path.join(root, 'scripts/sanitize-v1-post-019/expected-schema.json'), 'utf8')).tables);

function withoutCommentsAndStrings(source) {
  return source
    .replace(/--[^\r\n]*/g, ' ')
    .replace(/\$([a-zA-Z_][a-zA-Z_0-9]*)?\$[\s\S]*?\$\1\$/g, ' ')
    .replace(/'(?:''|[^'])*'/g, ' ')
    .replace(/"(?:""|[^"])*"/g, ' ');
}

function basicSqlBalance(source) {
  // Structural lexical check, not a PostgreSQL grammar parser.
  const without = withoutCommentsAndStrings(source);
  for (const fragment of [without, ...[...source.matchAll(
    /\$([a-zA-Z_][a-zA-Z_0-9]*)\$([\s\S]*?)\$\1\$/g)].map(m =>
    withoutCommentsAndStrings(m[2]))]) {
    let depth = 0;
    for (const char of fragment) {
      if (char === '(') depth++;
      if (char === ')') depth--;
      assert.ok(depth >= 0, 'unbalanced closing parenthesis');
    }
    assert.equal(depth, 0, 'unbalanced opening parenthesis');
  }
  assert.match(without, /^\s*BEGIN\s*(?:READ ONLY)?\s*;/i);
  assert.match(without, /COMMIT\s*;\s*$/i);
  assert.equal((source.match(/\$[a-zA-Z_0-9]*\$/g) || []).length % 2, 0,
    'unpaired dollar quote');
}

test('all four artifacts are lexically balanced and transaction-scoped', () => {
  for (const [name, content] of Object.entries(sql)) {
    assert.ok(content.endsWith('\n'), `${name}: missing final newline`);
    assert.doesNotMatch(content, /[ \t]+$/m, `${name}: trailing whitespace`);
    basicSqlBalance(content);
  }
});

test('UP creates exactly the approved four empty tables and no V1 DDL', () => {
  const created = [...sql.up.matchAll(/\bCREATE TABLE public\.([a-z_]+)\s*\(/gi)].map(m => m[1]);
  assert.deepEqual(created, tables);
  const cleaned = withoutCommentsAndStrings(sql.up);
  assert.doesNotMatch(cleaned, /\b(?:INSERT INTO|UPDATE public\.|DELETE FROM|CREATE POLICY|ALTER POLICY|ENABLE ROW LEVEL SECURITY|FORCE ROW LEVEL SECURITY)\b/i);
  assert.doesNotMatch(cleaned, /\b(?:ALTER|DROP|TRUNCATE) TABLE public\.(?:usuarios_administrativos|festas|clientes)\b/i);
  for (const v1 of v1Tables) {
    assert.doesNotMatch(cleaned, new RegExp(`\\b(?:CREATE|ALTER|DROP|TRUNCATE) TABLE public\\.${v1}\\b`, 'i'));
  }
  assert.equal(v1Tables.length, 63);
  assert.doesNotMatch(cleaned, /\bCREATE TABLE public\.(?:autorizacao_acoes|empresa_memberships)\b/i);
  for (const t of tables) assert.match(sql.up, new RegExp(`CREATE TABLE public\\.${t} \\(`));
  assert.doesNotMatch(cleaned, /\bCREATE ROLE\b|\bCREATE USER\b|\bGRANT\s+(?:SELECT|INSERT|UPDATE|DELETE|EXECUTE)\b/i);
  assert.doesNotMatch(cleaned, /\bGRANT ALL\b|\bALTER OWNER\b/i);
  for (const [key, content] of Object.entries(sql)) {
    for (const m of content.matchAll(/\bEXECUTE\s+format\(\s*'([^']+)'/g)) {
      assert.match(m[1], /^SELECT EXISTS \(SELECT 1 FROM public\.%I\)$/,
        `${key}: unexpected dynamic SQL`);
    }
  }
});

test('anti-cross-company uses two NOT NULL composite FKs, not trigger trust', () => {
  for (const col of ['empresa_id', 'estabelecimento_id', 'membership_id']) {
    assert.match(sql.up, new RegExp(`\\b${col} uuid NOT NULL`));
  }
  assert.match(sql.up, /FOREIGN KEY \(empresa_id,membership_id\)\s+REFERENCES public\.memberships\(empresa_id,id\) ON UPDATE RESTRICT ON DELETE RESTRICT/);
  assert.match(sql.up, /FOREIGN KEY \(empresa_id,estabelecimento_id\)\s+REFERENCES public\.estabelecimentos\(empresa_id,id\) ON UPDATE RESTRICT ON DELETE RESTRICT/);
  assert.match(sql.up, /UNIQUE \(empresa_id,id\)/);
  assert.match(sql.up, /UNIQUE \(empresa_id,codigo\)/);
  assert.match(sql.up, /UNIQUE \(empresa_id,usuario_id\)/);
  assert.match(sql.up, /UNIQUE \(empresa_id,estabelecimento_id,membership_id\)/);
  assert.match(sql.up, /ON public\.memberships \(usuario_id,empresa_id,status\)/);
  assert.doesNotMatch(sql.up, /ON public\.memberships \(usuario_id,status,empresa_id\)/);
  assert.match(sql.post, /ARRAY\['usuario_id','empresa_id','status'\]/);
  assert.doesNotMatch(sql.post, /ARRAY\['usuario_id','status','empresa_id'\]/);
  const design = fs.readFileSync(path.join(root, 'docs/architecture/SAAS-020-FOUNDATION-DESIGN.md'), 'utf8');
  assert.ok(design.includes('Índice `(usuario_id,empresa_id,status)`'));
  assert.match(sql.up, /ON public\.membership_estabelecimentos \(empresa_id,membership_id,estabelecimento_id\)/);
});

test('guards close activation, reparenting, delete and truncate paths', () => {
  assert.equal([...sql.up.matchAll(/CREATE FUNCTION public\.saas020_[a-z_]+\(\) RETURNS trigger/g)].length, 5);
  assert.equal([...sql.up.matchAll(/CREATE TRIGGER saas020_[a-z_]+_trg/g)].length, 8);
  assert.equal([...sql.up.matchAll(/BEFORE INSERT OR UPDATE OR DELETE ON public\./g)].length, 4);
  assert.equal([...sql.up.matchAll(/BEFORE TRUNCATE ON public\./g)].length, 4);
  for (const initial of ['PROVISIONAMENTO', 'SUSPENSO', 'PENDENTE', 'SUSPENSA']) {
    assert.match(sql.up, new RegExp(`NEW\\.status IS DISTINCT FROM '${initial}'`));
  }
  assert.match(sql.up, /NEW\.empresa_id IS DISTINCT FROM OLD\.empresa_id/);
  assert.match(sql.up, /NEW\.estabelecimento_id IS DISTINCT FROM OLD\.estabelecimento_id/);
  assert.match(sql.up, /NEW\.membership_id IS DISTINCT FROM OLD\.membership_id/);
  assert.match(sql.up, /NEW\.usuario_id IS DISTINCT FROM OLD\.usuario_id/);
  assert.match(sql.up, /NEW\.revisao := OLD\.revisao \+ 1/);
  assert.match(sql.up, /NEW\.revogado_em := clock_timestamp\(\)/);
  assert.match(sql.up, /NEW\.desativado_em := clock_timestamp\(\)/);
  assert.doesNotMatch(sql.up, /SECURITY DEFINER|session_replication_role|DISABLE TRIGGER/i);
});

test('PK, UNIQUE and CHECK declarations match the 020 contract', () => {
  const keys = [
    ['saas020_empresas_pk', 'PRIMARY KEY (id)'],
    ['saas020_empresas_codigo_uk', 'UNIQUE (codigo)'],
    ['saas020_estabelecimentos_pk', 'PRIMARY KEY (id)'],
    ['saas020_estabelecimentos_empresa_id_uk', 'UNIQUE (empresa_id,id)'],
    ['saas020_estabelecimentos_codigo_uk', 'UNIQUE (empresa_id,codigo)'],
    ['saas020_memberships_pk', 'PRIMARY KEY (id)'],
    ['saas020_memberships_empresa_id_uk', 'UNIQUE (empresa_id,id)'],
    ['saas020_memberships_empresa_usuario_uk', 'UNIQUE (empresa_id,usuario_id)'],
    ['saas020_memberships_empresa_id_usuario_uk', 'UNIQUE (empresa_id,id,usuario_id)'],
    ['saas020_me_pk', 'PRIMARY KEY (id)'],
    ['saas020_me_empresa_estab_membership_uk', 'UNIQUE (empresa_id,estabelecimento_id,membership_id)'],
    ['saas020_me_empresa_estab_id_uk', 'UNIQUE (empresa_id,estabelecimento_id,id)'],
  ];
  for (const [name, clause] of keys) {
    assert.ok(sql.up.includes(`CONSTRAINT ${name} ${clause}`), `missing ${name}`);
    assert.ok(sql.post.includes(`'${name}'`) && sql.down.includes(`'${name}'`), `unverified ${name}`);
  }
  assert.equal([...sql.up.matchAll(/CONSTRAINT saas020_[a-z_]+_(?:pk|uk)\b/g)].length, 12);
  const checks = [
    'saas020_empresas_codigo_ck','saas020_empresas_nome_ck',
    'saas020_empresas_status_ck','saas020_empresas_datas_ck',
    'saas020_estabelecimentos_codigo_ck','saas020_estabelecimentos_nome_ck',
    'saas020_estabelecimentos_status_ck','saas020_estabelecimentos_datas_ck',
    'saas020_memberships_status_ck','saas020_memberships_datas_ck',
    'saas020_memberships_revisao_ck','saas020_me_status_ck','saas020_me_datas_ck',
  ];
  for (const name of checks) {
    assert.ok(sql.up.includes(`CONSTRAINT ${name} CHECK (`), `missing ${name}`);
    assert.ok(sql.post.includes(`'${name}'`) && sql.down.includes(`'${name}'`), `unverified ${name}`);
  }
  assert.equal([...sql.up.matchAll(/CONSTRAINT saas020_[a-z_]+_ck\b/g)].length, 13);
  for (const fragment of [
    "codigo COLLATE \"C\" ~ '^[a-z][a-z0-9-]{1,62}[a-z0-9]$'",
    'length(btrim(nome)) BETWEEN 1 AND 160',
    "status IN ('PROVISIONAMENTO','ATIVA','SUSPENSA','DESATIVADA')",
    "status IN ('ATIVO','SUSPENSO','DESATIVADO')",
    "status IN ('PENDENTE','ATIVA','SUSPENSA','REVOGADA')",
    '(vigente_ate IS NULL OR vigente_ate > vigente_desde)',
    "((status = 'REVOGADA') = (revogado_em IS NOT NULL))",
    'CONSTRAINT saas020_memberships_revisao_ck CHECK (revisao > 0)',
  ]) assert.ok(sql.up.includes(fragment), `missing CHECK clause: ${fragment}`);
});

test('executor retains ownership and runtime receives no ACL', () => {
  assert.ok(sql.up.includes('saas020.runtime_roles') && sql.pre.includes('saas020.runtime_roles')
    && sql.post.includes('saas020.runtime_roles'));
  assert.doesNotMatch(sql.up, /saas020\.owner_role|ALTER TABLE public\.%I OWNER TO %I|CREATE ROLE/i);
  assert.match(sql.up, /REVOKE ALL ON TABLE/);
  assert.match(sql.up, /REVOKE ALL ON FUNCTION/);
  assert.match(sql.up, /has_any_column_privilege/);
  assert.match(sql.up, /MAINTAIN/);
  assert.doesNotMatch(sql.up, /^GRANT\s/m);
});

test('pre/postchecks are read-only and inspect baseline, empty rows and ACL', () => {
  for (const key of ['pre', 'post']) {
    assert.match(sql[key], /^--[^\n]*\n(?:--[^\n]*\n)*BEGIN READ ONLY;/);
    const cleaned = withoutCommentsAndStrings(sql[key]);
    assert.doesNotMatch(cleaned, /\b(?:CREATE TABLE|ALTER TABLE|DROP TABLE|INSERT INTO|UPDATE public\.|DELETE FROM|TRUNCATE TABLE|GRANT|REVOKE)\b/i);
  }
  assert.match(sql.pre, /63-table V1 identity differs/);
  assert.match(sql.pre, /87131946b52479651484ec9076ce264243e79867ab2bc1f02447c6a2eb0599a3/);
  assert.match(sql.pre, /017 effect absent/);
  assert.match(sql.post, /67-table shape absent/);
  assert.match(sql.post, /FK tuple\/action mismatch/);
  assert.match(sql.post, /Foundation must be empty/);
  assert.match(sql.post, /relrowsecurity OR c\.relforcerowsecurity/);
  assert.match(sql.post, /V1 structural projection changed/);
  assert.match(sql.post, /usuarios_administrativos/);
  assert.match(sql.post, /PK\/UNIQUE definition or order mismatch/);
  assert.match(sql.post, /CHECK canonical expression mismatch/);
  assert.match(sql.post, /guard definition\/properties mismatch/);
  assert.match(sql.post, /trigger wiring\/events mismatch/);
  assert.match(sql.post, /index definition mismatch/);
  assert.match(sql.post, /IS NOT TRUE/);
});

test('rollback refuses data/dependents and never uses CASCADE', () => {
  assert.match(sql.down, /rollback_no_consumers/);
  assert.match(sql.down, /ACCESS EXCLUSIVE MODE/g);
  assert.match(sql.down, /nonempty Foundation/);
  assert.match(sql.down, /forward-fix required/);
  assert.match(sql.down, /DROP TABLE public\.membership_estabelecimentos RESTRICT;/);
  assert.match(sql.down, /DROP TABLE public\.empresas RESTRICT;/);
  assert.doesNotMatch(withoutCommentsAndStrings(sql.down), /\bCASCADE\b|\bDELETE FROM\b|\bTRUNCATE TABLE\b/i);
  for (const token of ['column drift','PK/UNIQUE order drift','FK tuple drift',
    'CHECK canonical expression drift','guard body/properties drift','trigger wiring drift','index order drift']) {
    assert.ok(sql.down.includes(token), `rollback missing ${token}`);
  }
});

test('UP checks essential physical invariants before COMMIT', () => {
  const finalStart = sql.up.indexOf('DO $final$');
  const commit = sql.up.lastIndexOf('COMMIT;');
  assert.ok(finalStart > 0 && finalStart < commit);
  for (const token of ['intra-transaction structure failed','V1 structure changed inside migration',
    'saas020_me_membership_fk','saas020_me_estabelecimento_fk',
    'membership_estabelecimentos','saas020_memberships_usuario_empresa_status_idx']) {
    assert.ok(sql.up.slice(finalStart, commit).includes(token), `missing precommit ${token}`);
  }
  assert.match(sql.up, /expected_hash IS NULL OR expected_hash !~/);
  const final = sql.up.slice(finalStart, commit);
  assert.match(final, /c\.relname='membership_estabelecimentos'/);
  assert.match(final, /p\.relname=e\.parent/);
  assert.match(final, /unnest\(k\.conkey\)/);
  assert.match(final, /unnest\(k\.confkey\)/);
  assert.match(final, /NOT k\.condeferrable/);
  assert.match(final, /guard mismatch/);
});

test('CHECK verification binds every expression and protects OR grouping', () => {
  for (const key of ['post', 'down']) {
    const source = sql[key];
    assert.match(source, /AS compact,/);
    assert.match(source, /AS grouped/);
    assert.match(source, /a\.compact/);
    assert.match(source, /\)=e\.canonical/);
    for (const group of [
      '((desativado_emISNULL)OR(desativado_em>=criado_em))',
      '((vigente_ateISNULL)OR(vigente_ate>vigente_desde))',
      '((revogado_emISNULL)OR(revogado_em>=criado_em))',
      "((status=''REVOGADA'')=(revogado_emISNOTNULL))",
    ]) assert.ok(source.includes(group), `${key}: missing mandatory Boolean group ${group}`);
    assert.ok(source.includes("'((status=''DESATIVADA'')=(desativado_emISNOTNULL))'"));
    assert.ok(source.includes("'((status=''DESATIVADO'')=(desativado_emISNOTNULL))'"));
    assert.match(source, /regexp_matches\(a\.rawdef/);
    assert.match(source, /regexp_matches\(e\.canonical/);
    assert.match(source, /IS NOT DISTINCT FROM/);
    assert.match(source, /COLLATE "C"/);
    assert.doesNotMatch(source, /bool_and\(strpos|strpos\(a\.compact/);
  }
});

test('rollback verifies exact index shape and restores V1 fingerprint', () => {
  for (const token of ['NOT i.indisunique', 'i.indpred IS NULL', 'i.indexprs IS NULL',
    'i.indnkeyatts=3', 'unnest(i.indkey)', 'cardinality(g.tgattr)=0',
    'g.tgfoid=to_regprocedure']) assert.ok(sql.down.includes(token), token);
  assert.match(sql.down, /actual_hash IS DISTINCT FROM current_setting\('saas020\.v1_pre_hash'\)/);
  assert.ok(sql.down.lastIndexOf('V1 structural hash drift') < sql.down.lastIndexOf('COMMIT;'));
});

test('FK internal enforcement triggers and guard wiring are validated', () => {
  for (const key of ['up', 'post', 'down']) {
    assert.match(sql[key], /g\.tgfoid=to_regprocedure\(format\('public\.%I\(\)',/);
    assert.match(sql[key], /g\.tgconstraint/);
    assert.match(sql[key], /g\.tgenabled<>'O'/);
    assert.match(sql[key], /g\.tgisinternal/);
  }
  assert.match(sql.post, /c\.relnamespace='public'::regnamespace AND c\.relname=e\.child/);
  assert.match(sql.post, /p\.relnamespace='public'::regnamespace AND p\.relname=e\.parent/);
});

test('all 020 user triggers are inventoried, including disabled extras', () => {
  for (const key of ['up', 'post', 'down']) {
    // The set count must include both enabled and disabled user triggers;
    // the separate expected-row check still requires each approved trigger enabled.
    const inventories = [...sql[key].matchAll(
      /\(SELECT count\(\*\) FROM pg_trigger \w+ JOIN pg_class c ON c\.oid=\w+\.tgrelid([\s\S]*?)\)<>8/g)];
    assert.ok(inventories.some(([, body]) =>
      /c\.relnamespace='public'::regnamespace/.test(body) &&
      /AND NOT \w+\.tgisinternal/.test(body) &&
      !/tgenabled|tgtype/.test(body)), `${key}: missing unfiltered 8-trigger inventory`);
    assert.match(sql[key], /g\.tgenabled='O' AND NOT g\.tgisinternal|g\.tgtype=e\.kind AND g\.tgenabled='O'/,
      `${key}: expected trigger must remain enabled`);
    assert.match(sql[key], /g\.tgfoid=to_regprocedure/, `${key}: wrong function wiring must fail`);
  }
});

test('exactly five 020 routines are inventoried, including extra functions and procedures', () => {
  for (const key of ['up', 'post', 'down']) {
    const inventory = /\(SELECT count\(\*\) FROM pg_proc p WHERE p\.pronamespace='public'::regnamespace\s+AND left\(p\.proname,8\)='saas020_'\)<>5/;
    assert.match(sql[key], inventory, `${key}: extra saas020_* routine must fail`);
    const expected = sql[key].match(/WITH expected\((?:name,hash)\) AS \(VALUES[\s\S]*?SELECT 1 FROM expected e WHERE NOT EXISTS \([\s\S]*?\)/);
    assert.ok(expected, `${key}: expected five signatures missing`);
    for (const name of ['saas020_guard_empresas', 'saas020_guard_estabelecimentos',
      'saas020_guard_memberships', 'saas020_guard_membership_estabelecimentos',
      'saas020_bloquear_truncate']) assert.ok(expected[0].includes(`'${name}'`), `${key}: ${name}`);
    for (const property of ["p.prokind='f'", 'p.pronargs=0', "p.prorettype='trigger'::regtype",
      "p.provolatile='v'", 'NOT p.prosecdef', 'NOT p.proisstrict',
      'NOT p.proleakproof', "p.proparallel='u'", 'NOT p.proretset',
      "p.proconfig=ARRAY['search_path=pg_catalog, public']::text[]"])
      assert.ok(sql[key].includes(property), `${key}: missing ${property}`);
  }
});

test('UP performs exact trigger/function inventories before COMMIT', () => {
  const final = sql.up.slice(sql.up.indexOf('DO $final$'), sql.up.lastIndexOf('COMMIT;'));
  assert.match(final, /AND NOT g\.tgisinternal\)<>8/);
  assert.match(final, /AND left\(p\.proname,8\)='saas020_'\)<>5/);
  assert.match(final, /020 intra-transaction guard mismatch/);
});

test('D03 and D10 remain explicit rollout gates, not implicit 020 authorization', () => {
  const design = fs.readFileSync(path.join(root, 'docs/architecture/SAAS-020-FOUNDATION-DESIGN.md'), 'utf8');
  assert.match(design, /D03 e D10 permanecem MUST_DECIDE_BEFORE_FIRST_TENANT/);
  assert.match(design, /D03 n[aã]o permite wildcard/);
  assert.match(design, /D10 continua em aberto/);
  assert.match(design, /segundo tenant/i);
  assert.doesNotMatch(sql.up, /CREATE POLICY|ENABLE ROW LEVEL SECURITY|GRANT\s+.*\s+TO\s+.*runtime/i);
});

test('historical 017–019 checksums still match frozen baseline manifest', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'database/baseline/v1-post-019.manifest.json'), 'utf8'));
  const chain = manifest.ordered_chain.filter(x => ['017', '018', '019'].includes(x.logical_id));
  assert.equal(chain.length, 3);
  for (const entry of chain) {
    const bytes = fs.readFileSync(path.join(root, entry.path), 'utf8').replace(/\r\n?/g, '\n');
    assert.equal(crypto.createHash('sha256').update(bytes, 'utf8').digest('hex'),
      entry.sha256_utf8_lf, `${entry.logical_id} historic checksum`);
  }
});
