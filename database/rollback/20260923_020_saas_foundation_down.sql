-- 020 rollback is only for an empty, unused Foundation. NEVER automatic.
-- B2 must verify externally that no build/flow consumes the 020 schema.
-- Must run as the original executor-owner. Required: saas020.v1_pre_hash,
-- and saas020.rollback_no_consumers='approved' (operator attestation).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = pg_catalog, public;

DO $gate$
BEGIN
  IF nullif(current_setting('saas020.v1_pre_hash',true),'') IS NULL
     OR nullif(current_setting('saas020.v1_pre_hash',true),'') !~ '^[0-9a-f]{64}$'
     OR current_setting('saas020.rollback_no_consumers',true) IS DISTINCT FROM 'approved' THEN
    RAISE EXCEPTION '020 rollback: V1 hash and no-consumer attestation required'
      USING ERRCODE='55000';
  END IF;
  IF to_regclass('public.empresas') IS NULL
     OR to_regclass('public.estabelecimentos') IS NULL
     OR to_regclass('public.memberships') IS NULL
     OR to_regclass('public.membership_estabelecimentos') IS NULL THEN
    RAISE EXCEPTION '020 rollback: partial or absent Foundation' USING ERRCODE='55000'; END IF;
END $gate$;

-- Deterministic child-to-parent ACCESS EXCLUSIVE locks close the emptiness race.
LOCK TABLE public.membership_estabelecimentos IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.memberships IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.estabelecimentos IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.empresas IN ACCESS EXCLUSIVE MODE;

DO $verify$
DECLARE t text; occupied boolean;
        owner_oid oid := (SELECT oid FROM pg_roles WHERE rolname=current_user);
BEGIN
  IF owner_oid IS NULL THEN
    RAISE EXCEPTION '020 rollback: owner missing' USING ERRCODE='55000'; END IF;
  FOREACH t IN ARRAY ARRAY['membership_estabelecimentos','memberships','estabelecimentos','empresas'] LOOP
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I)',t) INTO occupied;
    IF occupied THEN
      RAISE EXCEPTION '020 rollback: nonempty Foundation; forward-fix required' USING ERRCODE='55000'; END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_class c WHERE c.relnamespace='public'::regnamespace
        AND c.relname IN ('empresas','estabelecimentos','memberships','membership_estabelecimentos')
        AND c.relkind='r' AND c.relowner=owner_oid AND NOT c.relrowsecurity
        AND NOT c.relforcerowsecurity)<>4
     OR (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
          WHERE c.relnamespace='public'::regnamespace
            AND c.relname IN ('empresas','estabelecimentos','memberships','membership_estabelecimentos')
            AND NOT t.tgisinternal)<>8
     OR (SELECT count(*) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
          AND left(p.proname,8)='saas020_')<>5
     OR EXISTS (SELECT 1 FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid
                WHERE c.relname IN ('empresas','estabelecimentos','memberships','membership_estabelecimentos'))
     OR EXISTS (SELECT 1 FROM pg_constraint k WHERE k.contype='f'
         AND k.confrelid IN (to_regclass('public.empresas'),
           to_regclass('public.estabelecimentos'),to_regclass('public.memberships'),
           to_regclass('public.membership_estabelecimentos'))
         AND k.conrelid NOT IN (to_regclass('public.empresas'),
           to_regclass('public.estabelecimentos'),to_regclass('public.memberships'),
           to_regclass('public.membership_estabelecimentos')))
     OR EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace,
                  LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
                WHERE n.nspname='public' AND c.relname IN
                  ('empresas','estabelecimentos','memberships','membership_estabelecimentos')
                  AND a.grantee<>owner_oid)
     OR EXISTS (SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid,
                  LATERAL aclexplode(a.attacl) x
                WHERE c.relnamespace='public'::regnamespace AND c.relname IN
                  ('empresas','estabelecimentos','memberships','membership_estabelecimentos')
                  AND a.attnum>0 AND NOT a.attisdropped AND x.grantee<>owner_oid)
     OR EXISTS (SELECT 1 FROM pg_proc p,
                  LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
                WHERE p.pronamespace='public'::regnamespace
                  AND p.proname IN ('saas020_guard_empresas','saas020_guard_estabelecimentos',
                    'saas020_guard_memberships','saas020_guard_membership_estabelecimentos',
                    'saas020_bloquear_truncate') AND a.grantee<>owner_oid) THEN
    RAISE EXCEPTION '020 rollback: drift, new dependency, policy or grant; refuse'
      USING ERRCODE='55000';
  END IF;
  IF EXISTS (
    WITH expected(tab,col,typ,nullable) AS (VALUES
      ('empresas','id','uuid',false),('empresas','codigo','text',false),
      ('empresas','nome','text',false),('empresas','status','text',false),
      ('empresas','criado_em','timestamp with time zone',false),
      ('empresas','atualizado_em','timestamp with time zone',false),
      ('empresas','desativado_em','timestamp with time zone',true),
      ('estabelecimentos','id','uuid',false),('estabelecimentos','empresa_id','uuid',false),
      ('estabelecimentos','codigo','text',false),('estabelecimentos','nome','text',false),
      ('estabelecimentos','status','text',false),
      ('estabelecimentos','criado_em','timestamp with time zone',false),
      ('estabelecimentos','atualizado_em','timestamp with time zone',false),
      ('estabelecimentos','desativado_em','timestamp with time zone',true),
      ('memberships','id','uuid',false),('memberships','empresa_id','uuid',false),
      ('memberships','usuario_id','uuid',false),('memberships','status','text',false),
      ('memberships','vigente_desde','timestamp with time zone',false),
      ('memberships','vigente_ate','timestamp with time zone',true),
      ('memberships','revogado_em','timestamp with time zone',true),
      ('memberships','criado_em','timestamp with time zone',false),
      ('memberships','atualizado_em','timestamp with time zone',false),
      ('memberships','revisao','bigint',false),
      ('membership_estabelecimentos','id','uuid',false),
      ('membership_estabelecimentos','empresa_id','uuid',false),
      ('membership_estabelecimentos','estabelecimento_id','uuid',false),
      ('membership_estabelecimentos','membership_id','uuid',false),
      ('membership_estabelecimentos','status','text',false),
      ('membership_estabelecimentos','vigente_desde','timestamp with time zone',false),
      ('membership_estabelecimentos','vigente_ate','timestamp with time zone',true),
      ('membership_estabelecimentos','revogado_em','timestamp with time zone',true),
      ('membership_estabelecimentos','criado_em','timestamp with time zone',false),
      ('membership_estabelecimentos','atualizado_em','timestamp with time zone',false)
    ), actual AS (
      SELECT c.relname::text tab,a.attname::text col,format_type(a.atttypid,a.atttypmod) typ,
             NOT a.attnotnull nullable,pg_get_expr(d.adbin,d.adrelid) def
      FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid
      LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE c.relnamespace='public'::regnamespace AND c.relname IN
        ('empresas','estabelecimentos','memberships','membership_estabelecimentos')
        AND a.attnum>0 AND NOT a.attisdropped
    )
    SELECT 1 FROM expected e FULL JOIN actual a USING (tab,col)
    WHERE e.tab IS NULL OR a.tab IS NULL OR a.typ<>e.typ OR a.nullable<>e.nullable
      OR (CASE WHEN a.col='id' THEN a.def IN ('gen_random_uuid()','pg_catalog.gen_random_uuid()')
          WHEN a.col IN ('criado_em','atualizado_em') THEN a.def IN ('now()','CURRENT_TIMESTAMP')
          WHEN a.tab='memberships' AND a.col='revisao' THEN a.def IN ('1','1::bigint')
          ELSE a.def IS NULL END) IS NOT TRUE
  ) THEN RAISE EXCEPTION '020 rollback: column drift' USING ERRCODE='55000'; END IF;
  IF (SELECT count(*) FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid
      WHERE c.relnamespace='public'::regnamespace AND c.relname IN
        ('empresas','estabelecimentos','memberships','membership_estabelecimentos')
        AND k.contype IN ('p','u','f','c'))<>30
     OR (SELECT count(*) FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid
         WHERE c.relnamespace='public'::regnamespace AND c.relname IN
           ('empresas','estabelecimentos','memberships','membership_estabelecimentos'))<>14
     OR EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid
                WHERE c.relnamespace='public'::regnamespace AND c.relname IN
                  ('empresas','estabelecimentos','memberships','membership_estabelecimentos')
                  AND (NOT i.indisvalid OR NOT i.indisready))
     OR (SELECT count(*) FROM pg_trigger g JOIN pg_class c ON c.oid=g.tgrelid
         WHERE c.relnamespace='public'::regnamespace AND c.relname IN
           ('empresas','estabelecimentos','memberships','membership_estabelecimentos')
           AND NOT g.tgisinternal)<>8 THEN
    RAISE EXCEPTION '020 rollback: constraint/index/trigger drift' USING ERRCODE='55000'; END IF;
  IF EXISTS (
    WITH expected(name,tab,kind,cols) AS (VALUES
      ('saas020_empresas_pk','empresas','p',ARRAY['id']),
      ('saas020_empresas_codigo_uk','empresas','u',ARRAY['codigo']),
      ('saas020_estabelecimentos_pk','estabelecimentos','p',ARRAY['id']),
      ('saas020_estabelecimentos_empresa_id_uk','estabelecimentos','u',ARRAY['empresa_id','id']),
      ('saas020_estabelecimentos_codigo_uk','estabelecimentos','u',ARRAY['empresa_id','codigo']),
      ('saas020_memberships_pk','memberships','p',ARRAY['id']),
      ('saas020_memberships_empresa_id_uk','memberships','u',ARRAY['empresa_id','id']),
      ('saas020_memberships_empresa_usuario_uk','memberships','u',ARRAY['empresa_id','usuario_id']),
      ('saas020_memberships_empresa_id_usuario_uk','memberships','u',ARRAY['empresa_id','id','usuario_id']),
      ('saas020_me_pk','membership_estabelecimentos','p',ARRAY['id']),
      ('saas020_me_empresa_estab_membership_uk','membership_estabelecimentos','u',ARRAY['empresa_id','estabelecimento_id','membership_id']),
      ('saas020_me_empresa_estab_id_uk','membership_estabelecimentos','u',ARRAY['empresa_id','estabelecimento_id','id'])
    )
    SELECT 1 FROM expected e WHERE NOT EXISTS (
      SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid
      WHERE c.relnamespace='public'::regnamespace AND c.relname=e.tab
        AND k.conname=e.name AND k.contype=e.kind::"char" AND k.convalidated
        AND NOT k.condeferrable
        AND (SELECT array_agg(a.attname::text ORDER BY x.ord)
             FROM unnest(k.conkey) WITH ORDINALITY x(attnum,ord)
             JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=x.attnum)=e.cols)
  ) THEN RAISE EXCEPTION '020 rollback: PK/UNIQUE order drift' USING ERRCODE='55000'; END IF;
  IF EXISTS (
    WITH expected(name,tab,parent,cols,refcols) AS (VALUES
      ('saas020_estabelecimentos_empresa_fk','estabelecimentos','empresas',ARRAY['empresa_id'],ARRAY['id']),
      ('saas020_memberships_empresa_fk','memberships','empresas',ARRAY['empresa_id'],ARRAY['id']),
      ('saas020_memberships_usuario_fk','memberships','usuarios_administrativos',ARRAY['usuario_id'],ARRAY['id']),
      ('saas020_me_membership_fk','membership_estabelecimentos','memberships',ARRAY['empresa_id','membership_id'],ARRAY['empresa_id','id']),
      ('saas020_me_estabelecimento_fk','membership_estabelecimentos','estabelecimentos',ARRAY['empresa_id','estabelecimento_id'],ARRAY['empresa_id','id'])
    )
    SELECT 1 FROM expected e WHERE NOT EXISTS (
      SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid
        JOIN pg_class p ON p.oid=k.confrelid
      WHERE c.relnamespace='public'::regnamespace AND c.relname=e.tab
        AND p.relnamespace='public'::regnamespace AND p.relname=e.parent
        AND k.conname=e.name AND k.contype='f' AND k.convalidated AND NOT k.condeferrable
        AND k.confupdtype='r' AND k.confdeltype='r'
        AND (SELECT array_agg(a.attname::text ORDER BY x.ord)
             FROM unnest(k.conkey) WITH ORDINALITY x(attnum,ord)
             JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=x.attnum)=e.cols
        AND (SELECT array_agg(a.attname::text ORDER BY x.ord)
             FROM unnest(k.confkey) WITH ORDINALITY x(attnum,ord)
             JOIN pg_attribute a ON a.attrelid=p.oid AND a.attnum=x.attnum)=e.refcols)
  ) THEN RAISE EXCEPTION '020 rollback: FK tuple drift' USING ERRCODE='55000'; END IF;
  IF (SELECT count(*) FROM pg_trigger g JOIN pg_constraint k ON k.oid=g.tgconstraint
      WHERE k.connamespace='public'::regnamespace AND k.contype='f'
        AND k.conname IN ('saas020_estabelecimentos_empresa_fk','saas020_memberships_empresa_fk',
          'saas020_memberships_usuario_fk','saas020_me_membership_fk',
          'saas020_me_estabelecimento_fk') AND g.tgisinternal)<>20
     OR EXISTS (SELECT 1 FROM pg_trigger g JOIN pg_constraint k ON k.oid=g.tgconstraint
       WHERE k.connamespace='public'::regnamespace AND k.contype='f'
         AND k.conname IN ('saas020_estabelecimentos_empresa_fk','saas020_memberships_empresa_fk',
           'saas020_memberships_usuario_fk','saas020_me_membership_fk',
           'saas020_me_estabelecimento_fk') AND (NOT g.tgisinternal OR g.tgenabled<>'O')) THEN
    RAISE EXCEPTION '020 rollback: FK enforcement trigger drift' USING ERRCODE='55000'; END IF;
  IF EXISTS (
    WITH expected(name,tab,canonical) AS (VALUES
      ('saas020_empresas_codigo_ck','empresas','codigoCOLLATE"C"~''^[a-z][a-z0-9-]{1,62}[a-z0-9]$'''),
      ('saas020_empresas_nome_ck','empresas','lengthbtrimnomeBETWEEN1AND160'),
      ('saas020_empresas_status_ck','empresas','statusIN''PROVISIONAMENTO'',''ATIVA'',''SUSPENSA'',''DESATIVADA'''),
      ('saas020_empresas_datas_ck','empresas','atualizado_em>=criado_emANDdesativado_emISNULLORdesativado_em>=criado_emANDstatus=''DESATIVADA''=desativado_emISNOTNULL'),
      ('saas020_estabelecimentos_codigo_ck','estabelecimentos','codigoCOLLATE"C"~''^[a-z][a-z0-9-]{1,62}[a-z0-9]$'''),
      ('saas020_estabelecimentos_nome_ck','estabelecimentos','lengthbtrimnomeBETWEEN1AND160'),
      ('saas020_estabelecimentos_status_ck','estabelecimentos','statusIN''ATIVO'',''SUSPENSO'',''DESATIVADO'''),
      ('saas020_estabelecimentos_datas_ck','estabelecimentos','atualizado_em>=criado_emANDdesativado_emISNULLORdesativado_em>=criado_emANDstatus=''DESATIVADO''=desativado_emISNOTNULL'),
      ('saas020_memberships_status_ck','memberships','statusIN''PENDENTE'',''ATIVA'',''SUSPENSA'',''REVOGADA'''),
      ('saas020_memberships_datas_ck','memberships','atualizado_em>=criado_emANDvigente_ateISNULLORvigente_ate>vigente_desdeANDrevogado_emISNULLORrevogado_em>=criado_emANDstatus=''REVOGADA''=revogado_emISNOTNULL'),
      ('saas020_memberships_revisao_ck','memberships','revisao>0'),
      ('saas020_me_status_ck','membership_estabelecimentos','statusIN''ATIVA'',''SUSPENSA'',''REVOGADA'''),
      ('saas020_me_datas_ck','membership_estabelecimentos','atualizado_em>=criado_emANDvigente_ateISNULLORvigente_ate>vigente_desdeANDrevogado_emISNULLORrevogado_em>=criado_emANDstatus=''REVOGADA''=revogado_emISNOTNULL')
    ), actual AS (
      SELECT k.conname,c.relname AS tab,
        replace(replace(regexp_replace(pg_get_constraintdef(k.oid),'[[:space:]()]','','g'),
                        '::text',''),'CHECK','') AS compact,
        replace(regexp_replace(pg_get_constraintdef(k.oid),'[[:space:]]','','g'),'::text','') AS grouped,
        pg_get_constraintdef(k.oid) AS rawdef
      FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid
      WHERE c.relnamespace='public'::regnamespace AND c.relname IN
        ('empresas','estabelecimentos','memberships','membership_estabelecimentos')
        AND k.contype='c' AND k.convalidated AND NOT k.condeferrable
    )
    SELECT 1 FROM expected e WHERE NOT EXISTS (
      SELECT 1 FROM actual a WHERE a.conname=e.name AND a.tab=e.tab
        AND (CASE WHEN e.name LIKE '%_nome_ck' THEN
              replace(a.compact,'lengthbtrimnome>=1ANDlengthbtrimnome<=160',
                                'lengthbtrimnomeBETWEEN1AND160')
             WHEN e.name LIKE '%_status_ck' THEN
              replace(replace(a.compact,'=ANYARRAY[','IN'),']','')
             ELSE a.compact END)=e.canonical
        AND (e.name NOT LIKE '%_datas_ck' OR
          (CASE WHEN e.name IN ('saas020_empresas_datas_ck','saas020_estabelecimentos_datas_ck') THEN
            strpos(a.grouped,'((desativado_emISNULL)OR(desativado_em>=criado_em))')>0
            AND strpos(a.grouped,CASE WHEN e.name='saas020_empresas_datas_ck' THEN
              '((status=''DESATIVADA'')=(desativado_emISNOTNULL))' ELSE
              '((status=''DESATIVADO'')=(desativado_emISNOTNULL))' END)>0
           ELSE strpos(a.grouped,'((vigente_ateISNULL)OR(vigente_ate>vigente_desde))')>0
            AND strpos(a.grouped,'((revogado_emISNULL)OR(revogado_em>=criado_em))')>0
            AND strpos(a.grouped,'((status=''REVOGADA'')=(revogado_emISNOTNULL))')>0 END))
        AND (e.name NOT LIKE '%_codigo_ck' OR strpos(a.rawdef,'COLLATE "C"')>0)
        AND (SELECT array_agg(m.parts[1] ORDER BY m.ord)
             FROM regexp_matches(a.rawdef, '''([^'']*)''', 'g') WITH ORDINALITY AS m(parts,ord))
            IS NOT DISTINCT FROM
            (SELECT array_agg(m.parts[1] ORDER BY m.ord)
             FROM regexp_matches(e.canonical, '''([^'']*)''', 'g') WITH ORDINALITY AS m(parts,ord)))
  ) THEN RAISE EXCEPTION '020 rollback: CHECK canonical expression drift' USING ERRCODE='55000'; END IF;
  IF EXISTS (
    WITH expected(name,hash) AS (VALUES
      ('saas020_guard_empresas','149e0795c5981c612279842c792075506953e13c2be0bb38d97de71b2bf06b28'),
      ('saas020_guard_estabelecimentos','d5b6fd30a58a2219a9d71a664df3c6a5aa2b76aaaf4bad4e7b105bf6c2e8dcaa'),
      ('saas020_guard_memberships','23468d3fe1b593fe2270b425bdae29378a6480c358c2826840b8ae5d7fafbe67'),
      ('saas020_guard_membership_estabelecimentos','e46c5baf5d44e2297b65c4018dee62e6012c324a5a1ce5ef951ad78446485239'),
      ('saas020_bloquear_truncate','d2f6d3bdc3e16027266abfd9e757ce29b1940ab84b277bf0b496fe90f49549ae')
    )
    SELECT 1 FROM expected e WHERE NOT EXISTS (
      SELECT 1 FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
         AND p.proname=e.name AND p.pronargs=0 AND p.prorettype='trigger'::regtype
         AND p.prokind='f' AND p.prolang=(SELECT oid FROM pg_language WHERE lanname='plpgsql')
         AND p.provolatile='v' AND NOT p.prosecdef AND NOT p.proisstrict
         AND NOT p.proleakproof AND p.proparallel='u' AND NOT p.proretset
         AND p.proowner=owner_oid
        AND p.proconfig=ARRAY['search_path=pg_catalog, public']::text[]
        AND encode(sha256(convert_to(replace(p.prosrc,E'\r',''),'UTF8')),'hex')=e.hash)
  ) THEN RAISE EXCEPTION '020 rollback: guard body/properties drift' USING ERRCODE='55000'; END IF;
  IF EXISTS (
    WITH expected(trigger_name,tab,fn,kind) AS (VALUES
      ('saas020_empresas_guard_trg','empresas','saas020_guard_empresas',31),
      ('saas020_estabelecimentos_guard_trg','estabelecimentos','saas020_guard_estabelecimentos',31),
      ('saas020_memberships_guard_trg','memberships','saas020_guard_memberships',31),
      ('saas020_me_guard_trg','membership_estabelecimentos','saas020_guard_membership_estabelecimentos',31),
      ('saas020_empresas_truncate_trg','empresas','saas020_bloquear_truncate',34),
      ('saas020_estabelecimentos_truncate_trg','estabelecimentos','saas020_bloquear_truncate',34),
      ('saas020_memberships_truncate_trg','memberships','saas020_bloquear_truncate',34),
      ('saas020_me_truncate_trg','membership_estabelecimentos','saas020_bloquear_truncate',34)
    )
    SELECT 1 FROM expected e WHERE NOT EXISTS (
      SELECT 1 FROM pg_trigger g JOIN pg_class c ON c.oid=g.tgrelid
      WHERE c.relnamespace='public'::regnamespace AND c.relname=e.tab
        AND g.tgname=e.trigger_name
        AND g.tgfoid=to_regprocedure(format('public.%I()',e.fn))
        AND g.tgtype=e.kind AND g.tgenabled='O' AND NOT g.tgisinternal
        AND g.tgqual IS NULL AND g.tgnargs=0 AND octet_length(g.tgargs)=0
        AND cardinality(g.tgattr)=0 AND g.tgoldtable IS NULL AND g.tgnewtable IS NULL)
  ) THEN RAISE EXCEPTION '020 rollback: trigger wiring drift' USING ERRCODE='55000'; END IF;
  IF EXISTS (
    WITH expected(idx,tab,cols) AS (VALUES
      ('saas020_memberships_usuario_empresa_status_idx','memberships',ARRAY['usuario_id','empresa_id','status']),
      ('saas020_me_empresa_membership_estab_idx','membership_estabelecimentos',ARRAY['empresa_id','membership_id','estabelecimento_id'])
    )
    SELECT 1 FROM expected e WHERE NOT EXISTS (
      SELECT 1 FROM pg_class x JOIN pg_index i ON i.indexrelid=x.oid
        JOIN pg_class c ON c.oid=i.indrelid
      WHERE x.relnamespace='public'::regnamespace AND x.relname=e.idx
        AND c.relnamespace='public'::regnamespace AND c.relname=e.tab
        AND i.indisvalid AND i.indisready AND NOT i.indisunique
        AND i.indpred IS NULL AND i.indexprs IS NULL AND i.indnkeyatts=3
        AND (SELECT array_agg(a.attname::text ORDER BY k.ord)
             FROM unnest(i.indkey) WITH ORDINALITY k(attnum,ord)
             JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=k.attnum)=e.cols)
  ) THEN
    RAISE EXCEPTION '020 rollback: index order drift' USING ERRCODE='55000'; END IF;
  -- DROP ... RESTRICT below is the definitive dependency check for views,
  -- functions, FKs and every other object not captured by the early checks.
END $verify$;

DROP TABLE public.membership_estabelecimentos RESTRICT;
DROP TABLE public.memberships RESTRICT;
DROP TABLE public.estabelecimentos RESTRICT;
DROP TABLE public.empresas RESTRICT;
DROP FUNCTION public.saas020_guard_membership_estabelecimentos() RESTRICT;
DROP FUNCTION public.saas020_guard_memberships() RESTRICT;
DROP FUNCTION public.saas020_guard_estabelecimentos() RESTRICT;
DROP FUNCTION public.saas020_guard_empresas() RESTRICT;
DROP FUNCTION public.saas020_bloquear_truncate() RESTRICT;

DO $after$
DECLARE actual_hash text;
BEGIN
  IF (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind='r')<>63
     OR EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                 WHERE n.nspname='public' AND left(c.relname,8)='saas020_')
     OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                 WHERE n.nspname='public' AND left(p.proname,8)='saas020_') THEN
    RAISE EXCEPTION '020 rollback: post-state differs from V1' USING ERRCODE='55000'; END IF;
  WITH v1 AS (
    SELECT c.oid,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind='r'
  ), projection AS (
    SELECT v.relname,
      (SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),
         a.attnotnull,pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum)
       FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
       WHERE a.attrelid=v.oid AND a.attnum>0 AND NOT a.attisdropped) AS columns,
      (SELECT jsonb_agg(jsonb_build_array(k.conname,k.contype,pg_get_constraintdef(k.oid)) ORDER BY k.conname)
       FROM pg_constraint k WHERE k.conrelid=v.oid) AS constraints,
      (SELECT jsonb_agg(pg_get_indexdef(i.indexrelid) ORDER BY x.relname)
       FROM pg_index i JOIN pg_class x ON x.oid=i.indexrelid WHERE i.indrelid=v.oid) AS indexes,
      (SELECT jsonb_agg(pg_get_triggerdef(g.oid) ORDER BY g.tgname)
       FROM pg_trigger g WHERE g.tgrelid=v.oid AND NOT g.tgisinternal) AS triggers
    FROM v1 v
  )
  SELECT encode(sha256(convert_to(jsonb_agg(to_jsonb(projection) ORDER BY relname)::text,'UTF8')),'hex')
    INTO actual_hash FROM projection;
  IF actual_hash IS DISTINCT FROM current_setting('saas020.v1_pre_hash') THEN
    RAISE EXCEPTION '020 rollback: V1 structural hash drift' USING ERRCODE='55000'; END IF;
END $after$;
COMMIT;
