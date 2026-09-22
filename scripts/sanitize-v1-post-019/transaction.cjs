'use strict';

const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { TARGET, PSQL, PROFILE, guardTarget, hash, stable, refuse, assertDigest,
  assertPreflight, nativeEnvironment, safeCode } = require('./guards.cjs');
const { assertPolicy, assertManifests, assertSealed, assertInventory, assertSnapshot, SOURCE_COMMIT } = require('./checks.cjs');

function ident(name) { if (!/^[a-z][a-z0-9_]+$/.test(name)) refuse('POLICY_INVALID'); return `"${name}"`; }
function tables(policy, rule) { return Object.keys(policy.tables).filter(t => !rule || policy.tables[t] === rule).sort(); }
function destructiveSQL(policy) {
  assertPolicy(policy);
  return `TRUNCATE TABLE ${tables(policy, 'EMPTY').map(t => `public.${ident(t)}`).join(', ')} CONTINUE IDENTITY RESTRICT;`;
}
function locksSQL(policy) {
  assertPolicy(policy);
  return `LOCK TABLE ${tables(policy, 'EMPTY').map(t => `public.${ident(t)}`).join(', ')} IN ACCESS EXCLUSIVE MODE;\n` +
    `LOCK TABLE ${tables(policy, 'PRESERVE_CANONICAL').map(t => `public.${ident(t)}`).join(', ')} IN ACCESS SHARE MODE;`;
}
const PREFLIGHT = `SELECT json_build_object('database',current_database(),'host',host(inet_server_addr()),
 'port',inet_server_port(),'user',current_user,'default_read_only',current_setting('default_transaction_read_only'),
 'read_only',current_setting('transaction_read_only'),'encoding',current_setting('server_encoding'),
 'version_num',current_setting('server_version_num')::int);`;
const INVENTORY = `SELECT coalesce(jsonb_object_agg(relname,cols),'{}'::jsonb) FROM (
 SELECT c.relname,jsonb_agg(a.attname ORDER BY a.attname) cols FROM pg_catalog.pg_class c
 JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
 JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
 WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f') GROUP BY c.relname) s;`;

// B5B-2A canonicalization. Internal trigger names/definitions can contain OID-derived
// names, and ACL array order is not semantic, so both are projected as stable fields.
const CANONICALIZATION = 'V1_POST019_PG18_SEMANTIC_V1';
const STRUCTURE = `WITH domain AS (
 SELECT c.*,n.nspname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
), trigger_projection AS (
 SELECT c.nspname schema_name,c.relname relation_name,
  CASE WHEN t.tgisinternal THEN concat('constraint:',coalesce(cn.nspname,''),'.',coalesce(con.conname,''),':',t.tgtype,':',pn.nspname,'.',p.proname,'(',pg_get_function_identity_arguments(p.oid),')') ELSE concat('named:',t.tgname) END identity,
  CASE WHEN t.tgisinternal THEN jsonb_build_array(c.nspname,c.relname,'INTERNAL_CONSTRAINT',cn.nspname,con.conname,t.tgtype,t.tgenabled,pn.nspname,p.proname,pg_get_function_identity_arguments(p.oid),t.tgdeferrable,t.tginitdeferred)
       ELSE jsonb_build_array(c.nspname,c.relname,'NAMED',t.tgname,t.tgtype,t.tgenabled,pg_get_triggerdef(t.oid)) END payload
 FROM domain c JOIN pg_trigger t ON t.tgrelid=c.oid JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace pn ON pn.oid=p.pronamespace
 LEFT JOIN pg_constraint con ON con.oid=t.tgconstraint LEFT JOIN pg_namespace cn ON cn.oid=con.connamespace
), acl_projection AS (
 SELECT 'database' kind,NULL::text schema_name,d.datname object_name,NULL::text subobject,pg_get_userbyid(x.grantor) grantor,CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END grantee,x.privilege_type,x.is_grantable
 FROM pg_database d CROSS JOIN LATERAL aclexplode(coalesce(d.datacl,acldefault('d',d.datdba))) x WHERE d.datname IN (current_database(),'postgres','template0','template1')
 UNION ALL SELECT 'schema',n.nspname,n.nspname,NULL,pg_get_userbyid(x.grantor),CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,x.privilege_type,x.is_grantable
 FROM pg_namespace n CROSS JOIN LATERAL aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) x WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
 UNION ALL SELECT CASE WHEN c.relkind='S' THEN 'sequence' ELSE 'relation' END,c.nspname,c.relname,NULL,pg_get_userbyid(x.grantor),CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,x.privilege_type,x.is_grantable
 FROM domain c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault((CASE WHEN c.relkind='S' THEN 'S' ELSE 'r' END)::"char",c.relowner))) x
 UNION ALL SELECT 'column',c.nspname,c.relname,a.attname,pg_get_userbyid(x.grantor),CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,x.privilege_type,x.is_grantable
 FROM domain c JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped CROSS JOIN LATERAL aclexplode(a.attacl) x WHERE a.attacl IS NOT NULL
 UNION ALL SELECT 'function',n.nspname,p.proname,pg_get_function_identity_arguments(p.oid),pg_get_userbyid(x.grantor),CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,x.privilege_type,x.is_grantable
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
 UNION ALL SELECT 'type',n.nspname,t.typname,NULL,pg_get_userbyid(x.grantor),CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,x.privilege_type,x.is_grantable
 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace CROSS JOIN LATERAL aclexplode(coalesce(t.typacl,acldefault('T',t.typowner))) x WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
), components AS (SELECT jsonb_build_object(
 'canonicalization','${CANONICALIZATION}',
 'server',current_setting('server_version_num'),
 'database',(SELECT (to_jsonb(d)-ARRAY['oid','datname','datdba','datfrozenxid','datminmxid','datacl','dattablespace']) || jsonb_build_object('owner',pg_get_userbyid(d.datdba),'tablespace',(SELECT spcname FROM pg_tablespace WHERE oid=d.dattablespace),'comment',shobj_description(d.oid,'pg_database')) FROM pg_database d WHERE d.datname=current_database()),
 'cluster_databases',(SELECT jsonb_agg(jsonb_build_array(datname,pg_get_userbyid(datdba),datallowconn,datconnlimit) ORDER BY datname) FROM pg_database),
 'schemas',(SELECT jsonb_agg(jsonb_build_array(nspname,pg_get_userbyid(nspowner)) ORDER BY nspname) FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname<>'information_schema'),
 'relations',(SELECT jsonb_agg(jsonb_build_array(nspname,relname,relkind,relpersistence,relrowsecurity,relforcerowsecurity,relispartition,relreplident,reloptions,pg_get_userbyid(relowner)) ORDER BY nspname,relname) FROM domain),
 'columns',(SELECT jsonb_agg(jsonb_build_array(c.nspname,c.relname,a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,a.attidentity,a.attgenerated,a.attisdropped,a.atthasmissing,a.attmissingval::text,pg_get_expr(d.adbin,d.adrelid),co.collname) ORDER BY c.nspname,c.relname,a.attnum)
 FROM domain c JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum LEFT JOIN pg_collation co ON co.oid=a.attcollation),
 'constraints',(SELECT jsonb_agg(jsonb_build_array(n.nspname,c.conname,r.relname,c.contype,c.convalidated,c.condeferrable,c.condeferred,pg_get_constraintdef(c.oid)) ORDER BY n.nspname,r.relname,c.conname) FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace LEFT JOIN pg_class r ON r.oid=c.conrelid WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'),
 'indexes',(SELECT jsonb_agg(jsonb_build_array(c.nspname,c.relname,pg_get_indexdef(i.indexrelid),i.indisvalid,i.indisready) ORDER BY c.nspname,c.relname) FROM domain c JOIN pg_index i ON i.indexrelid=c.oid),
 'triggers',(SELECT jsonb_agg(payload ORDER BY schema_name,relation_name,identity) FROM trigger_projection),
 'functions',(SELECT jsonb_agg(jsonb_build_array(n.nspname,p.proname,pg_get_function_identity_arguments(p.oid),pg_get_function_arguments(p.oid),pg_get_function_result(p.oid),l.lanname,p.provolatile,p.prosecdef,p.proleakproof,p.proisstrict,p.proparallel,p.prokind,p.proconfig,p.procost,p.prorows,p.prosrc,p.probin,pg_get_userbyid(p.proowner)) ORDER BY n.nspname,p.proname,pg_get_function_identity_arguments(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'),
 'extensions',(SELECT jsonb_agg(jsonb_build_array(e.extname,e.extversion,n.nspname,pg_get_userbyid(e.extowner)) ORDER BY e.extname) FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace),
 'sequences',(SELECT jsonb_agg(jsonb_build_array(c.nspname,c.relname,s.seqstart,s.seqincrement,s.seqmin,s.seqmax,s.seqcache,s.seqcycle,r.relname,a.attname,d.deptype) ORDER BY c.nspname,c.relname) FROM domain c JOIN pg_sequence s ON s.seqrelid=c.oid LEFT JOIN pg_depend d ON d.classid='pg_class'::regclass AND d.objid=c.oid AND d.refclassid='pg_class'::regclass AND d.deptype IN ('a','i') LEFT JOIN pg_class r ON r.oid=d.refobjid LEFT JOIN pg_attribute a ON a.attrelid=r.oid AND a.attnum=d.refobjsubid),
 'rules',(SELECT jsonb_agg(jsonb_build_array(c.nspname,c.relname,r.rulename,pg_get_ruledef(r.oid)) ORDER BY c.nspname,c.relname,r.rulename) FROM domain c JOIN pg_rewrite r ON r.ev_class=c.oid),
 'types',(SELECT jsonb_agg(jsonb_build_array(n.nspname,t.typname,t.typtype,t.typcategory,format_type(t.typbasetype,t.typtypmod),t.typnotnull,t.typdefault,pg_get_userbyid(t.typowner)) ORDER BY n.nspname,t.typname) FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'),
 'enums',(SELECT jsonb_agg(jsonb_build_array(n.nspname,t.typname,e.enumlabel,e.enumsortorder) ORDER BY n.nspname,t.typname,e.enumsortorder) FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid JOIN pg_namespace n ON n.oid=t.typnamespace),
 'acl',(SELECT jsonb_agg(jsonb_build_array(kind,schema_name,object_name,subobject,grantor,grantee,privilege_type,is_grantable) ORDER BY kind,schema_name,object_name,subobject,grantor,grantee,privilege_type,is_grantable) FROM acl_projection),
 'default_privileges',(SELECT jsonb_agg(jsonb_build_array(pg_get_userbyid(d.defaclrole),n.nspname,d.defaclobjtype,pg_get_userbyid(x.grantor),CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,x.privilege_type,x.is_grantable) ORDER BY pg_get_userbyid(d.defaclrole),n.nspname,d.defaclobjtype,pg_get_userbyid(x.grantor),x.grantee,x.privilege_type,x.is_grantable) FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid=d.defaclnamespace CROSS JOIN LATERAL aclexplode(d.defaclacl) x),
 'roles',(SELECT jsonb_agg(jsonb_build_array(rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolconnlimit,rolvaliduntil,rolbypassrls,rolconfig) ORDER BY rolname) FROM pg_roles),
 'memberships',(SELECT coalesce(jsonb_agg(jsonb_build_array(pg_get_userbyid(roleid),pg_get_userbyid(member),pg_get_userbyid(grantor),admin_option,inherit_option,set_option) ORDER BY pg_get_userbyid(roleid),pg_get_userbyid(member),pg_get_userbyid(grantor)),'[]'::jsonb) FROM pg_auth_members),
 'role_settings',(SELECT coalesce(jsonb_agg(jsonb_build_array(pg_get_userbyid(s.setrole),d.datname,v.setting) ORDER BY pg_get_userbyid(s.setrole),d.datname,v.setting),'[]'::jsonb) FROM pg_db_role_setting s LEFT JOIN pg_database d ON d.oid=s.setdatabase CROSS JOIN LATERAL unnest(s.setconfig) v(setting)),
 'descriptions',(SELECT jsonb_agg(jsonb_build_array(o.type,o.schema,o.identity,d.description) ORDER BY o.type,o.schema,o.identity) FROM pg_description d CROSS JOIN LATERAL pg_identify_object(d.classoid,d.objoid,d.objsubid) o WHERE o.schema IS NULL OR (o.schema !~ '^pg_' AND o.schema<>'information_schema'))
 ) value) SELECT json_build_object('sha256',encode(sha256(convert_to(value::text,'UTF8')),'hex'),'canonicalization','${CANONICALIZATION}','component_sha256',(SELECT jsonb_object_agg(key,encode(sha256(convert_to(component::text,'UTF8')),'hex') ORDER BY key) FROM jsonb_each(value) e(key,component))) FROM components;`;

function hazardSQL(policy) {
  const empty = tables(policy, 'EMPTY').map(t => `'${t}'`).join(',');
  return `SELECT json_build_object('hazards',
 (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND (n.nspname<>'public' OR c.relkind NOT IN ('r','i','S') OR c.relispartition OR c.relrowsecurity OR c.relforcerowsecurity)) +
 (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND ((t.tgtype & 32)<>0 OR t.tgenabled<>'O')) +
 (SELECT count(*) FROM pg_constraint WHERE NOT convalidated) +
 (SELECT count(*) FROM pg_index WHERE NOT indisvalid OR NOT indisready) +
 (SELECT count(*) FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND a.attisdropped) +
 (SELECT count(*) FROM pg_inherits) + (SELECT count(*) FROM pg_policy) + (SELECT count(*) FROM pg_event_trigger) +
 (SELECT count(*) FROM pg_largeobject_metadata) + (SELECT count(*) FROM pg_foreign_server) +
 (SELECT count(*) FROM pg_publication) + (SELECT count(*) FROM pg_subscription) +
 (SELECT count(*) FROM pg_database WHERE datname NOT IN (current_database(),'postgres','template0','template1')) +
 (SELECT count(*) FROM pg_roles WHERE rolname !~ '^pg_' AND rolname NOT IN ('postgres','kidmais_b5b_owner','kidmais_b5b_sanitizer')) +
 (SELECT count(*) FROM pg_constraint f JOIN pg_class src ON src.oid=f.conrelid JOIN pg_namespace sn ON sn.oid=src.relnamespace JOIN pg_class dst ON dst.oid=f.confrelid JOIN pg_namespace dn ON dn.oid=dst.relnamespace WHERE f.contype='f' AND dn.nspname='public' AND dst.relname IN (${empty}) AND (sn.nspname<>'public' OR src.relname NOT IN (${empty}))));`;
}
function catalogSQL(catalog) {
  const parts = Object.entries(catalog.tables).map(([table, expected]) => {
    const columns = Object.keys(expected[0]);
    const pairs = columns.map(col => {
      const ref = catalog.reference_keys[col];
      let expr = ref ? `(SELECT codigo FROM public.${ident(ref)} r WHERE r.id=t.${ident(col)})` : `t.${ident(col)}`;
      if (table === 'configuracao_agenda' && ['horario_inicio_padrao', 'horario_fim_padrao'].includes(col)) expr = `t.${ident(col)}::text`;
      return `'${col}',${expr}`;
    });
    return `'${table}',(SELECT coalesce(jsonb_agg(jsonb_build_object(${pairs.join(',')})),'[]'::jsonb) FROM public.${ident(table)} t)`;
  });
  return `SELECT jsonb_build_object(${parts.join(',')});`;
}
function countsSQL(policy) {
  assertPolicy(policy);
  return `SELECT jsonb_object_agg(table_name,row_count) FROM (${tables(policy).map(t => `SELECT '${t}'::text AS table_name,count(*) AS row_count FROM public.${ident(t)}`).join(' UNION ALL ')}) counts;`;
}
function identitySQL(catalog) {
  return `SELECT json_build_object('sha256',encode(sha256(convert_to(jsonb_build_object(${Object.keys(catalog.tables).sort().map(t => `'${t}',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.${ident(t)} t)`).join(',')})::text,'UTF8')),'hex'));`;
}
// Sequence relations are identified by pg_depend; no names from operational rows.
const SEQUENCES = `SELECT coalesce(jsonb_agg(jsonb_build_object('name',c.relname,'start',s.seqstart,'owner_table',r.relname) ORDER BY c.relname),'[]'::jsonb) FROM pg_sequence s JOIN pg_class c ON c.oid=s.seqrelid JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_depend d ON d.objid=c.oid AND d.classid='pg_class'::regclass AND d.deptype IN ('a','i') LEFT JOIN pg_class r ON r.oid=d.refobjid WHERE n.nspname='public';`;

async function snapshot(session, manifests, post = false) {
  const { policy, schema, catalog } = manifests;
  const inventory = await session.json(INVENTORY);
  try { assertInventory(inventory, schema, policy); } catch { refuse('INVENTORY_MISMATCH'); }
  const structure = await session.json(STRUCTURE);
  const hazards = await session.json(hazardSQL(policy));
  if (structure.sha256 !== schema.physical_projection.sha256 || structure.canonicalization !== schema.physical_projection.canonicalization ||
      stable(structure.component_sha256) !== stable(schema.physical_projection.component_sha256) || hazards.hazards !== 0) refuse('STRUCTURE_MISMATCH');
  // Read contents only after structure (including executable objects/RLS) has matched.
  const values = await session.json(catalogSQL(catalog));
  const counts = await session.json(countsSQL(policy));
  const identity = await session.json(identitySQL(catalog));
  const sequences = await session.json(SEQUENCES);
  if (stable(sequences.map(s => s.name).sort()) !== stable([
    'festa_contagens_convidados_sequencia_seq', 'festa_eventos_sequencia_seq']) ||
    sequences.some(s => policy.tables[s.owner_table] !== 'EMPTY' || !Number.isSafeInteger(s.start))) refuse('POSTCHECK_FAILED');
  const sequenceStates = {};
  for (const sequence of sequences) {
    const state = await session.json(`SELECT json_build_object('value',last_value,'called',is_called) FROM public.${ident(sequence.name)};`);
    if (!Number.isSafeInteger(state.value) || typeof state.called !== 'boolean') refuse('POSTCHECK_FAILED');
    sequenceStates[sequence.name] = state;
  }
  return { inventory, catalog: values, counts, structure_sha256: structure.sha256,
    catalog_identity_sha256: identity.sha256, hazards: hazards.hazards, sequence_states: sequenceStates };
}
function planFor(target, manifests, before) {
  guardTarget(target); assertManifests(manifests);
  const plan = { version: 1, profile: PROFILE, source_commit: SOURCE_COMMIT, target,
    policy_sha256: hash(stable(manifests.policy)), schema_sha256: hash(stable(manifests.schema)),
    catalog_sha256: hash(stable(manifests.catalog)), structure_sha256: before.structure_sha256,
    catalog_identity_sha256: before.catalog_identity_sha256,
    counts: before.counts, sequence_states: before.sequence_states,
    lock_sql: locksSQL(manifests.policy), destructive_sql: destructiveSQL(manifests.policy) };
  return { ...plan, digest: hash(stable(plan)) };
}

class PsqlSession {
  constructor(target) {
    guardTarget(target);
    this.pending = null; this.buffer = ''; this.closed = false; this.aborted = false; this.sequence = 0;
    this.child = spawn(PSQL, ['-X', '-w', '-A', '-t', '-v', 'ON_ERROR_STOP=0', '-v', 'VERBOSITY=sqlstate',
      '-h', target.host, '-p', String(target.port), '-U', target.user,
      '-d', `host=${target.host} hostaddr=${target.host} port=${target.port} user=${target.user} dbname=${target.database} sslmode=disable gssencmode=disable connect_timeout=5`],
    { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: nativeEnvironment(process.env) });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => this.receive(chunk));
    // Server diagnostics can include row contents; drain without retaining them.
    this.child.stderr.on('data', () => {});
    this.child.on('error', () => this.fail());
    this.child.on('close', () => { this.closed = true; this.fail(); });
    this.child.stdin.on('error', () => this.fail());
  }
  fail() {
    if (this.pending) { const p = this.pending; this.pending = null; clearTimeout(p.timer);
      p.reject(Object.assign(new Error('PROCESS_FAILED'), { code: 'PROCESS_FAILED' })); }
  }
  receive(chunk) {
    this.buffer += chunk;
    if (this.buffer.length > 8 * 1024 * 1024) { this.fail(); this.close(); return; }
    let newline;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, ''); this.buffer = this.buffer.slice(newline + 1);
      const p = this.pending;
      if (!p) continue;
      if (line.startsWith(p.marker)) {
        this.pending = null; clearTimeout(p.timer);
        const frame = line.match(new RegExp(`^${p.marker} (true|false) ([0-9A-Z]{5})$`));
        if (!frame) p.reject(Object.assign(new Error('PROTOCOL_FAILED'), { code: 'PROTOCOL_FAILED' }));
        else if (frame[1] === 'true') {
          this.aborted = true;
          p.reject(Object.assign(new Error('SQL_FAILED'), { code: 'SQL_FAILED', sqlstate: frame[2] }));
        } else { if (p.rollback) this.aborted = false; p.resolve(p.lines); }
      }
      else if (line) { p.size += line.length; if (p.size > 8 * 1024 * 1024) { this.fail(); this.close(); return; } p.lines.push(line); }
    }
  }
  command(sql) {
    if (this.closed || this.pending || (this.aborted && sql !== 'ROLLBACK;')) return Promise.reject(Object.assign(new Error('PROTOCOL_FAILED'), { code: 'PROTOCOL_FAILED' }));
    return new Promise((resolve, reject) => {
      const marker = `SANITIZER_${++this.sequence}_${randomBytes(16).toString('hex')}`;
      const timer = setTimeout(() => { this.fail(); this.close(); }, 45000);
      this.pending = { resolve, reject, marker, timer, lines: [], size: 0, rollback: sql === 'ROLLBACK;' };
      this.child.stdin.write(`${sql}\n\\echo ${marker} :ERROR :SQLSTATE\n`);
    });
  }
  async json(sql) {
    const lines = await this.command(sql);
    if (lines.length !== 1) refuse('PROTOCOL_FAILED');
    try { return JSON.parse(lines[0]); } catch { refuse('PROTOCOL_FAILED'); }
  }
  close() { this.closed = true; this.child.stdin.end(); this.child.kill(); }
}

async function execute(options, manifests, { sessionFactory = target => new PsqlSession(target), readSnapshot = snapshot,
  hooks = Object.freeze({}) } = {}) {
  guardTarget(options.target); assertManifests(manifests); assertSealed(manifests.schema);
  // Guard mode even for programmatic use (CLI adds the explicit authorization string).
  if (!['dry-run', 'apply', 'verify'].includes(options.mode)) refuse('INVALID_ARGUMENT');
  if (options.mode === 'apply' && options.authorized !== true) refuse('AUTHORIZATION_REQUIRED');
  const session = sessionFactory(options.target);
  let commitSent = false; let commitConfirmed = false; let rollbackConfirmed = false;
  let stage = 'READ_ONLY_BEGIN';
  try {
    await session.command('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;');
    stage = 'READ_ONLY_PREFLIGHT';
    assertPreflight(await session.json(PREFLIGHT), options.target);
    stage = 'READ_ONLY_SNAPSHOT';
    const before = await readSnapshot(session, manifests, options.mode === 'verify');
    assertSnapshot(before, manifests.schema, manifests.catalog, manifests.policy, options.mode === 'verify');
    const plan = planFor(options.target, manifests, before);
    stage = 'READ_ONLY_ROLLBACK';
    const rolled = await session.command('ROLLBACK;');
    if (stable(rolled) !== stable(['ROLLBACK'])) refuse('PROTOCOL_FAILED');
    rollbackConfirmed = true;
    if (options.mode !== 'apply') return { status: options.mode === 'verify' ? 'PASS' : 'PLAN', plan, counts: before.counts, commitConfirmed, rollbackConfirmed, transactionOutcome: 'ROLLED_BACK' };
    assertDigest(options.planDigest, plan.digest);
    rollbackConfirmed = false;
    stage = 'READ_WRITE_BEGIN';
    await session.command('BEGIN TRANSACTION ISOLATION LEVEL READ COMMITTED READ WRITE;');
    stage = 'READ_WRITE_PREFLIGHT';
    assertPreflight(await session.json(PREFLIGHT), options.target, false);
    stage = 'ADVISORY_LOCK';
    await session.command('SELECT pg_advisory_xact_lock(195019, 1);');
    stage = 'TABLE_LOCKS';
    for (const lock of locksSQL(manifests.policy).split('\n')) await session.command(lock);
    if (hooks.afterLocks) await hooks.afterLocks(session);
    stage = 'LOCKED_SNAPSHOT';
    const locked = await readSnapshot(session, manifests);
    assertSnapshot(locked, manifests.schema, manifests.catalog, manifests.policy, false, before);
    assertDigest(options.planDigest, planFor(options.target, manifests, locked).digest);
    if (hooks.beforeTruncate) await hooks.beforeTruncate(session);
    stage = 'TRUNCATE';
    await session.command(destructiveSQL(manifests.policy));
    if (hooks.afterTruncate) await hooks.afterTruncate(session);
    stage = 'CONSTRAINT_CHECK';
    await session.command('SET CONSTRAINTS ALL IMMEDIATE;');
    if (hooks.beforePostcheck) await hooks.beforePostcheck(session);
    stage = 'POSTCHECK';
    const after = await readSnapshot(session, manifests, true);
    assertSnapshot(after, manifests.schema, manifests.catalog, manifests.policy, true, locked);
    if (hooks.beforeCommit) await hooks.beforeCommit(session);
    stage = 'COMMIT';
    commitSent = true;
    const committed = await session.command('COMMIT;');
    if (stable(committed) !== stable(['COMMIT'])) refuse('PROTOCOL_FAILED');
    commitConfirmed = true;
    return { status: 'PASS', plan, counts: after.counts, commitConfirmed, rollbackConfirmed: false, transactionOutcome: 'COMMITTED' };
  } catch (error) {
    if (!commitSent) {
      try { rollbackConfirmed = stable(await session.command('ROLLBACK;')) === stable(['ROLLBACK']); } catch { rollbackConfirmed = false; }
    }
    return { status: commitSent && !commitConfirmed ? 'COMMIT_UNKNOWN' : 'FAIL',
      code: safeCode(error), stage, sqlstate: /^[0-9][A-Z0-9]{4}$/.test(error?.sqlstate || '') ? error.sqlstate : null,
      commitConfirmed, rollbackConfirmed,
      transactionOutcome: commitSent ? 'COMMIT_OUTCOME_UNKNOWN' : rollbackConfirmed ? 'ROLLED_BACK' : 'TRANSACTION_OUTCOME_UNKNOWN' };
  } finally { session.close(); }
}

module.exports = { TARGET, CANONICALIZATION, destructiveSQL, locksSQL, PREFLIGHT, INVENTORY, STRUCTURE, hazardSQL,
  catalogSQL, countsSQL, identitySQL, planFor, PsqlSession, execute, snapshot };
