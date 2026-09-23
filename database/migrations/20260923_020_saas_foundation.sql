-- 020 SaaS foundation. SCHEMA ONLY. Never run without the approved B2 owner/ACL gate.
-- Executor retains ownership in this schema-only slice (R1 decision). B2 must
-- approve its nominal identity and complete saas020.runtime_roles session list.
-- The separate 020 precheck and a V1 catalog snapshot must pass before this file.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = pg_catalog, public;

DO $gate$
DECLARE runtime_names text := nullif(current_setting('saas020.runtime_roles', true), '');
        expected_hash text := nullif(current_setting('saas020.v1_pre_hash', true), '');
BEGIN
  IF runtime_names IS NULL OR expected_hash IS NULL OR expected_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION '020 runtime inventory/owner gate unresolved' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(string_to_array(runtime_names, ',')) AS r(name)
             WHERE btrim(r.name) = '' OR btrim(r.name) = current_user
                OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = btrim(r.name))
                OR pg_has_role(btrim(r.name),current_user,'MEMBER')
                OR has_schema_privilege(btrim(r.name),'public','CREATE')) THEN
    RAISE EXCEPTION '020 runtime role inventory invalid' USING ERRCODE = '42501';
  END IF;
  IF (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r') <> 63
     OR to_regclass('public.usuarios_administrativos') IS NULL
     OR to_regclass('public.whatsapp_onboarding_tentativas') IS NULL
     OR to_regprocedure('public.kidmais019_ocupa(uuid)') IS NULL
     OR to_regprocedure('public.kidmais_ocupacoes_operacionais(date,date)') IS NULL
     OR to_regprocedure('pg_catalog.gen_random_uuid()') IS NULL
     OR EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'public' AND c.relname IN
                  ('empresas','estabelecimentos','memberships','membership_estabelecimentos')) THEN
    RAISE EXCEPTION '020 baseline/absence gate failed' USING ERRCODE = '55000';
  END IF;
END $gate$;

CREATE TABLE public.empresas (
  id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  codigo text NOT NULL,
  nome text NOT NULL,
  status text NOT NULL,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  desativado_em timestamptz,
  CONSTRAINT saas020_empresas_pk PRIMARY KEY (id),
  CONSTRAINT saas020_empresas_codigo_uk UNIQUE (codigo),
  CONSTRAINT saas020_empresas_codigo_ck CHECK (codigo COLLATE "C" ~ '^[a-z][a-z0-9-]{1,62}[a-z0-9]$'),
  CONSTRAINT saas020_empresas_nome_ck CHECK (length(btrim(nome)) BETWEEN 1 AND 160),
  CONSTRAINT saas020_empresas_status_ck CHECK (status IN ('PROVISIONAMENTO','ATIVA','SUSPENSA','DESATIVADA')),
  CONSTRAINT saas020_empresas_datas_ck CHECK (atualizado_em >= criado_em
    AND (desativado_em IS NULL OR desativado_em >= criado_em)
    AND ((status = 'DESATIVADA') = (desativado_em IS NOT NULL)))
);

CREATE TABLE public.estabelecimentos (
  id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  empresa_id uuid NOT NULL,
  codigo text NOT NULL,
  nome text NOT NULL,
  status text NOT NULL,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  desativado_em timestamptz,
  CONSTRAINT saas020_estabelecimentos_pk PRIMARY KEY (id),
  CONSTRAINT saas020_estabelecimentos_empresa_fk FOREIGN KEY (empresa_id)
    REFERENCES public.empresas(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT saas020_estabelecimentos_empresa_id_uk UNIQUE (empresa_id,id),
  CONSTRAINT saas020_estabelecimentos_codigo_uk UNIQUE (empresa_id,codigo),
  CONSTRAINT saas020_estabelecimentos_codigo_ck CHECK (codigo COLLATE "C" ~ '^[a-z][a-z0-9-]{1,62}[a-z0-9]$'),
  CONSTRAINT saas020_estabelecimentos_nome_ck CHECK (length(btrim(nome)) BETWEEN 1 AND 160),
  CONSTRAINT saas020_estabelecimentos_status_ck CHECK (status IN ('ATIVO','SUSPENSO','DESATIVADO')),
  CONSTRAINT saas020_estabelecimentos_datas_ck CHECK (atualizado_em >= criado_em
    AND (desativado_em IS NULL OR desativado_em >= criado_em)
    AND ((status = 'DESATIVADO') = (desativado_em IS NOT NULL)))
);

CREATE TABLE public.memberships (
  id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  empresa_id uuid NOT NULL,
  usuario_id uuid NOT NULL,
  status text NOT NULL,
  vigente_desde timestamptz NOT NULL,
  vigente_ate timestamptz,
  revogado_em timestamptz,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  revisao bigint NOT NULL DEFAULT 1,
  CONSTRAINT saas020_memberships_pk PRIMARY KEY (id),
  CONSTRAINT saas020_memberships_empresa_fk FOREIGN KEY (empresa_id)
    REFERENCES public.empresas(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT saas020_memberships_usuario_fk FOREIGN KEY (usuario_id)
    REFERENCES public.usuarios_administrativos(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT saas020_memberships_empresa_id_uk UNIQUE (empresa_id,id),
  CONSTRAINT saas020_memberships_empresa_usuario_uk UNIQUE (empresa_id,usuario_id),
  CONSTRAINT saas020_memberships_empresa_id_usuario_uk UNIQUE (empresa_id,id,usuario_id),
  CONSTRAINT saas020_memberships_status_ck CHECK (status IN ('PENDENTE','ATIVA','SUSPENSA','REVOGADA')),
  CONSTRAINT saas020_memberships_datas_ck CHECK (atualizado_em >= criado_em
    AND (vigente_ate IS NULL OR vigente_ate > vigente_desde)
    AND (revogado_em IS NULL OR revogado_em >= criado_em)
    AND ((status = 'REVOGADA') = (revogado_em IS NOT NULL))),
  CONSTRAINT saas020_memberships_revisao_ck CHECK (revisao > 0)
);
CREATE INDEX saas020_memberships_usuario_empresa_status_idx
  ON public.memberships (usuario_id,empresa_id,status);

CREATE TABLE public.membership_estabelecimentos (
  id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  empresa_id uuid NOT NULL,
  estabelecimento_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  status text NOT NULL,
  vigente_desde timestamptz NOT NULL,
  vigente_ate timestamptz,
  revogado_em timestamptz,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT saas020_me_pk PRIMARY KEY (id),
  CONSTRAINT saas020_me_membership_fk FOREIGN KEY (empresa_id,membership_id)
    REFERENCES public.memberships(empresa_id,id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT saas020_me_estabelecimento_fk FOREIGN KEY (empresa_id,estabelecimento_id)
    REFERENCES public.estabelecimentos(empresa_id,id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT saas020_me_empresa_estab_membership_uk UNIQUE (empresa_id,estabelecimento_id,membership_id),
  CONSTRAINT saas020_me_empresa_estab_id_uk UNIQUE (empresa_id,estabelecimento_id,id),
  CONSTRAINT saas020_me_status_ck CHECK (status IN ('ATIVA','SUSPENSA','REVOGADA')),
  CONSTRAINT saas020_me_datas_ck CHECK (atualizado_em >= criado_em
    AND (vigente_ate IS NULL OR vigente_ate > vigente_desde)
    AND (revogado_em IS NULL OR revogado_em >= criado_em)
    AND ((status = 'REVOGADA') = (revogado_em IS NOT NULL)))
);
CREATE INDEX saas020_me_empresa_membership_estab_idx
  ON public.membership_estabelecimentos (empresa_id,membership_id,estabelecimento_id);

-- Each guard is invoker-only and has no authorization side effects.
CREATE FUNCTION public.saas020_guard_empresas() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $guard$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION '020: physical DELETE refused' USING ERRCODE='23514'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status IS DISTINCT FROM 'PROVISIONAMENTO' OR NEW.desativado_em IS NOT NULL THEN
      RAISE EXCEPTION '020: empresa must start non-operational' USING ERRCODE='23514'; END IF;
    NEW.criado_em := clock_timestamp(); NEW.atualizado_em := NEW.criado_em;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.codigo IS DISTINCT FROM OLD.codigo
     OR NEW.criado_em IS DISTINCT FROM OLD.criado_em
     OR NEW.desativado_em IS DISTINCT FROM OLD.desativado_em THEN
    RAISE EXCEPTION '020: immutable empresa field' USING ERRCODE='23514'; END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT ((OLD.status='PROVISIONAMENTO' AND NEW.status='DESATIVADA')
         OR (OLD.status='ATIVA' AND NEW.status IN ('SUSPENSA','DESATIVADA'))
         OR (OLD.status='SUSPENSA' AND NEW.status='DESATIVADA')) THEN
      RAISE EXCEPTION '020: empresa transition refused' USING ERRCODE='23514'; END IF;
    IF NEW.status='DESATIVADA' THEN NEW.desativado_em := clock_timestamp(); END IF;
  END IF;
  NEW.atualizado_em := clock_timestamp();
  RETURN NEW;
END $guard$;

CREATE FUNCTION public.saas020_guard_estabelecimentos() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $guard$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION '020: physical DELETE refused' USING ERRCODE='23514'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status IS DISTINCT FROM 'SUSPENSO' OR NEW.desativado_em IS NOT NULL THEN
      RAISE EXCEPTION '020: estabelecimento must start non-operational' USING ERRCODE='23514'; END IF;
    NEW.criado_em := clock_timestamp(); NEW.atualizado_em := NEW.criado_em;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.empresa_id IS DISTINCT FROM OLD.empresa_id
     OR NEW.codigo IS DISTINCT FROM OLD.codigo OR NEW.criado_em IS DISTINCT FROM OLD.criado_em
     OR NEW.desativado_em IS DISTINCT FROM OLD.desativado_em THEN
    RAISE EXCEPTION '020: immutable estabelecimento field' USING ERRCODE='23514'; END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT ((OLD.status='ATIVO' AND NEW.status IN ('SUSPENSO','DESATIVADO'))
         OR (OLD.status='SUSPENSO' AND NEW.status='DESATIVADO')) THEN
      RAISE EXCEPTION '020: estabelecimento transition refused' USING ERRCODE='23514'; END IF;
    IF NEW.status='DESATIVADO' THEN NEW.desativado_em := clock_timestamp(); END IF;
  END IF;
  NEW.atualizado_em := clock_timestamp();
  RETURN NEW;
END $guard$;

CREATE FUNCTION public.saas020_guard_memberships() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $guard$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION '020: physical DELETE refused' USING ERRCODE='23514'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status IS DISTINCT FROM 'PENDENTE' OR NEW.revogado_em IS NOT NULL
       OR NEW.revisao IS DISTINCT FROM 1 THEN
      RAISE EXCEPTION '020: membership must start pending' USING ERRCODE='23514'; END IF;
    NEW.criado_em := clock_timestamp(); NEW.atualizado_em := NEW.criado_em;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.empresa_id IS DISTINCT FROM OLD.empresa_id
     OR NEW.usuario_id IS DISTINCT FROM OLD.usuario_id
     OR NEW.criado_em IS DISTINCT FROM OLD.criado_em
     OR NEW.revogado_em IS DISTINCT FROM OLD.revogado_em
     OR NEW.revisao IS DISTINCT FROM OLD.revisao THEN
    RAISE EXCEPTION '020: immutable membership field' USING ERRCODE='23514'; END IF;
  IF NEW.vigente_desde < OLD.vigente_desde
     OR (OLD.vigente_ate IS NOT NULL AND
         (NEW.vigente_ate IS NULL OR NEW.vigente_ate > OLD.vigente_ate)) THEN
    RAISE EXCEPTION '020: membership validity expansion refused' USING ERRCODE='23514'; END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT ((OLD.status='PENDENTE' AND NEW.status='REVOGADA')
         OR (OLD.status='ATIVA' AND NEW.status IN ('SUSPENSA','REVOGADA'))
         OR (OLD.status='SUSPENSA' AND NEW.status='REVOGADA')) THEN
      RAISE EXCEPTION '020: membership transition refused' USING ERRCODE='23514'; END IF;
    IF NEW.status='REVOGADA' THEN NEW.revogado_em := clock_timestamp(); END IF;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     OR NEW.vigente_desde IS DISTINCT FROM OLD.vigente_desde
     OR NEW.vigente_ate IS DISTINCT FROM OLD.vigente_ate THEN
    IF OLD.revisao = 9223372036854775807 THEN
      RAISE EXCEPTION '020: membership revision overflow' USING ERRCODE='22003'; END IF;
    NEW.revisao := OLD.revisao + 1;
  END IF;
  NEW.atualizado_em := clock_timestamp();
  RETURN NEW;
END $guard$;

CREATE FUNCTION public.saas020_guard_membership_estabelecimentos() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $guard$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION '020: physical DELETE refused' USING ERRCODE='23514'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status IS DISTINCT FROM 'SUSPENSA' OR NEW.revogado_em IS NOT NULL THEN
      RAISE EXCEPTION '020: unit link must start suspended' USING ERRCODE='23514'; END IF;
    NEW.criado_em := clock_timestamp(); NEW.atualizado_em := NEW.criado_em;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.empresa_id IS DISTINCT FROM OLD.empresa_id
     OR NEW.membership_id IS DISTINCT FROM OLD.membership_id
     OR NEW.estabelecimento_id IS DISTINCT FROM OLD.estabelecimento_id
     OR NEW.criado_em IS DISTINCT FROM OLD.criado_em
     OR NEW.revogado_em IS DISTINCT FROM OLD.revogado_em THEN
    RAISE EXCEPTION '020: immutable unit link field' USING ERRCODE='23514'; END IF;
  IF NEW.vigente_desde < OLD.vigente_desde
     OR (OLD.vigente_ate IS NOT NULL AND
         (NEW.vigente_ate IS NULL OR NEW.vigente_ate > OLD.vigente_ate)) THEN
    RAISE EXCEPTION '020: unit link validity expansion refused' USING ERRCODE='23514'; END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT ((OLD.status='ATIVA' AND NEW.status IN ('SUSPENSA','REVOGADA'))
         OR (OLD.status='SUSPENSA' AND NEW.status='REVOGADA')) THEN
      RAISE EXCEPTION '020: unit link transition refused' USING ERRCODE='23514'; END IF;
    IF NEW.status='REVOGADA' THEN NEW.revogado_em := clock_timestamp(); END IF;
  END IF;
  NEW.atualizado_em := clock_timestamp();
  RETURN NEW;
END $guard$;

CREATE FUNCTION public.saas020_bloquear_truncate() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $guard$
BEGIN
  RAISE EXCEPTION '020: TRUNCATE refused' USING ERRCODE='23514';
END $guard$;

CREATE TRIGGER saas020_empresas_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON public.empresas
  FOR EACH ROW EXECUTE FUNCTION public.saas020_guard_empresas();
CREATE TRIGGER saas020_estabelecimentos_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON public.estabelecimentos
  FOR EACH ROW EXECUTE FUNCTION public.saas020_guard_estabelecimentos();
CREATE TRIGGER saas020_memberships_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON public.memberships
  FOR EACH ROW EXECUTE FUNCTION public.saas020_guard_memberships();
CREATE TRIGGER saas020_me_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON public.membership_estabelecimentos
  FOR EACH ROW EXECUTE FUNCTION public.saas020_guard_membership_estabelecimentos();
CREATE TRIGGER saas020_empresas_truncate_trg BEFORE TRUNCATE ON public.empresas
  FOR EACH STATEMENT EXECUTE FUNCTION public.saas020_bloquear_truncate();
CREATE TRIGGER saas020_estabelecimentos_truncate_trg BEFORE TRUNCATE ON public.estabelecimentos
  FOR EACH STATEMENT EXECUTE FUNCTION public.saas020_bloquear_truncate();
CREATE TRIGGER saas020_memberships_truncate_trg BEFORE TRUNCATE ON public.memberships
  FOR EACH STATEMENT EXECUTE FUNCTION public.saas020_bloquear_truncate();
CREATE TRIGGER saas020_me_truncate_trg BEFORE TRUNCATE ON public.membership_estabelecimentos
  FOR EACH STATEMENT EXECUTE FUNCTION public.saas020_bloquear_truncate();

-- No runtime grant. PostgreSQL grants EXECUTE on new functions to PUBLIC by default.
REVOKE ALL ON TABLE public.empresas, public.estabelecimentos, public.memberships,
  public.membership_estabelecimentos FROM PUBLIC;
REVOKE ALL ON FUNCTION public.saas020_guard_empresas(),
  public.saas020_guard_estabelecimentos(), public.saas020_guard_memberships(),
  public.saas020_guard_membership_estabelecimentos(), public.saas020_bloquear_truncate() FROM PUBLIC;

-- Abort rather than publish if default privileges or role inheritance leak access.
DO $acl$
DECLARE runtime_names text := current_setting('saas020.runtime_roles');
        r text; t text; f text;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace,
      LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
    WHERE n.nspname='public' AND c.relname IN
      ('empresas','estabelecimentos','memberships','membership_estabelecimentos')
      AND a.grantee <> c.relowner
  ) OR EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace,
      LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE n.nspname='public' AND p.proname IN
      ('saas020_guard_empresas','saas020_guard_estabelecimentos','saas020_guard_memberships',
       'saas020_guard_membership_estabelecimentos','saas020_bloquear_truncate')
      AND a.grantee <> p.proowner
  ) OR EXISTS (
    SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace,
      LATERAL aclexplode(a.attacl) x
    WHERE n.nspname='public' AND c.relname IN
      ('empresas','estabelecimentos','memberships','membership_estabelecimentos')
      AND a.attnum>0 AND NOT a.attisdropped AND x.grantee<>c.relowner
  ) THEN RAISE EXCEPTION '020 unexpected direct ACL; transaction rolled back' USING ERRCODE='42501'; END IF;
  FOREACH r IN ARRAY string_to_array(runtime_names, ',') LOOP
    r := btrim(r);
    IF r='' OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=r)
       OR pg_has_role(r,current_user,'MEMBER')
       OR has_schema_privilege(r,'public','CREATE') THEN
      RAISE EXCEPTION '020 runtime role can reach foundation owner/objects' USING ERRCODE='42501';
    END IF;
    FOREACH t IN ARRAY ARRAY['empresas','estabelecimentos','memberships','membership_estabelecimentos'] LOOP
      IF has_table_privilege(r,format('public.%I',t),
           'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
         OR has_any_column_privilege(r,format('public.%I',t),
           'SELECT,INSERT,UPDATE,REFERENCES') THEN
        RAISE EXCEPTION '020 runtime table/column ACL' USING ERRCODE='42501'; END IF;
    END LOOP;
    FOREACH f IN ARRAY ARRAY['saas020_guard_empresas','saas020_guard_estabelecimentos',
                            'saas020_guard_memberships','saas020_guard_membership_estabelecimentos',
                            'saas020_bloquear_truncate'] LOOP
      IF has_function_privilege(r,format('public.%I()',f),'EXECUTE') THEN
        RAISE EXCEPTION '020 runtime function ACL' USING ERRCODE='42501'; END IF;
    END LOOP;
  END LOOP;
END $acl$;

-- Essential structural proof occurs before COMMIT, so a mismatch rolls back
-- CREATE/REVOKE and cannot publish a partial Foundation.
DO $final$
DECLARE actual_hash text; t text; occupied boolean;
BEGIN
  IF (SELECT count(*) FROM pg_class c WHERE c.relnamespace='public'::regnamespace
        AND c.relkind='r')<>67
     OR (SELECT count(*) FROM pg_class c WHERE c.relnamespace='public'::regnamespace
         AND c.relname IN ('empresas','estabelecimentos','memberships','membership_estabelecimentos')
         AND c.relkind='r' AND c.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)
         AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity)<>4
     OR EXISTS (SELECT 1 FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid
                WHERE c.relname IN ('empresas','estabelecimentos','memberships','membership_estabelecimentos'))
     OR (SELECT count(*) FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid
         WHERE c.relnamespace='public'::regnamespace AND c.relname IN
           ('empresas','estabelecimentos','memberships','membership_estabelecimentos')
           AND k.contype='p')<>4
     OR (SELECT count(*) FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid
         WHERE c.relnamespace='public'::regnamespace AND c.relname IN
           ('empresas','estabelecimentos','memberships','membership_estabelecimentos')
           AND k.contype='u')<>8
     OR (SELECT count(*) FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid
         WHERE c.relnamespace='public'::regnamespace AND c.relname IN
           ('empresas','estabelecimentos','memberships','membership_estabelecimentos')
           AND k.contype='f' AND k.convalidated AND k.confupdtype='r' AND k.confdeltype='r')<>5
     OR (SELECT count(*) FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid
         WHERE c.relnamespace='public'::regnamespace AND c.relname IN
           ('empresas','estabelecimentos','memberships','membership_estabelecimentos')
           AND k.contype='c' AND k.convalidated)<>13
     OR (SELECT count(*) FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid
         WHERE c.relnamespace='public'::regnamespace AND c.relname IN
           ('empresas','estabelecimentos','memberships','membership_estabelecimentos')
           AND i.indisvalid AND i.indisready)<>14
     OR (SELECT count(*) FROM pg_trigger g JOIN pg_class c ON c.oid=g.tgrelid
         WHERE c.relnamespace='public'::regnamespace AND c.relname IN
           ('empresas','estabelecimentos','memberships','membership_estabelecimentos')
            AND NOT g.tgisinternal)<>8
     OR (SELECT count(*) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
          AND left(p.proname,8)='saas020_')<>5
     OR EXISTS (
       WITH expected(name,parent,cols,refcols) AS (VALUES
         ('saas020_me_membership_fk','memberships',ARRAY['empresa_id','membership_id'],ARRAY['empresa_id','id']),
         ('saas020_me_estabelecimento_fk','estabelecimentos',ARRAY['empresa_id','estabelecimento_id'],ARRAY['empresa_id','id'])
       )
       SELECT 1 FROM expected e WHERE NOT EXISTS (
         SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid
           JOIN pg_class p ON p.oid=k.confrelid
         WHERE c.relnamespace='public'::regnamespace
           AND c.relname='membership_estabelecimentos'
           AND p.relnamespace='public'::regnamespace AND p.relname=e.parent
           AND k.conname=e.name AND k.contype='f' AND k.convalidated AND NOT k.condeferrable
           AND k.confupdtype='r' AND k.confdeltype='r'
           AND (SELECT array_agg(a.attname::text ORDER BY x.ord)
                FROM unnest(k.conkey) WITH ORDINALITY x(attnum,ord)
                JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=x.attnum)=e.cols
           AND (SELECT array_agg(a.attname::text ORDER BY x.ord)
                FROM unnest(k.confkey) WITH ORDINALITY x(attnum,ord)
                JOIN pg_attribute a ON a.attrelid=p.oid AND a.attnum=x.attnum)=e.refcols)
     )
     OR NOT EXISTS (SELECT 1 FROM pg_index i JOIN pg_class x ON x.oid=i.indexrelid
                    WHERE x.relnamespace='public'::regnamespace
                      AND x.relname='saas020_memberships_usuario_empresa_status_idx'
                      AND i.indisvalid AND i.indisready
                      AND pg_get_indexdef(i.indexrelid) LIKE '%(usuario_id, empresa_id, status)%')
     OR (SELECT count(*) FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
         WHERE c.relnamespace='public'::regnamespace
           AND c.relname='membership_estabelecimentos'
           AND a.attname IN ('empresa_id','membership_id','estabelecimento_id')
           AND a.attnotnull)<>3 THEN
    RAISE EXCEPTION '020 intra-transaction structure failed' USING ERRCODE='55000';
  END IF;
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
        AND p.proowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)
        AND p.proconfig=ARRAY['search_path=pg_catalog, public']::text[]
        AND encode(sha256(convert_to(replace(p.prosrc,E'\r',''),'UTF8')),'hex')=e.hash)
  ) OR EXISTS (
    SELECT 1 FROM pg_trigger g JOIN pg_class c ON c.oid=g.tgrelid
    WHERE c.relnamespace='public'::regnamespace AND c.relname IN
      ('empresas','estabelecimentos','memberships','membership_estabelecimentos')
      AND NOT g.tgisinternal AND (g.tgqual IS NOT NULL OR g.tgenabled<>'O'
        OR g.tgnargs<>0 OR octet_length(g.tgargs)<>0 OR cardinality(g.tgattr)<>0)
  ) OR EXISTS (
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
        AND g.tgname=e.trigger_name AND g.tgtype=e.kind AND g.tgenabled='O'
        AND g.tgfoid=to_regprocedure(format('public.%I()',e.fn))
        AND NOT g.tgisinternal AND g.tgqual IS NULL AND g.tgnargs=0
        AND octet_length(g.tgargs)=0 AND cardinality(g.tgattr)=0)
  ) OR (SELECT count(*) FROM pg_trigger g JOIN pg_constraint k ON k.oid=g.tgconstraint
        WHERE k.connamespace='public'::regnamespace AND k.contype='f'
          AND k.conname IN ('saas020_estabelecimentos_empresa_fk','saas020_memberships_empresa_fk',
            'saas020_memberships_usuario_fk','saas020_me_membership_fk',
            'saas020_me_estabelecimento_fk') AND g.tgisinternal)<>20
     OR EXISTS (SELECT 1 FROM pg_trigger g JOIN pg_constraint k ON k.oid=g.tgconstraint
         WHERE k.connamespace='public'::regnamespace AND k.contype='f'
           AND k.conname IN ('saas020_estabelecimentos_empresa_fk','saas020_memberships_empresa_fk',
             'saas020_memberships_usuario_fk','saas020_me_membership_fk',
             'saas020_me_estabelecimento_fk') AND (NOT g.tgisinternal OR g.tgenabled<>'O'))
  THEN RAISE EXCEPTION '020 intra-transaction guard mismatch' USING ERRCODE='55000'; END IF;
  FOREACH t IN ARRAY ARRAY['empresas','estabelecimentos','memberships','membership_estabelecimentos'] LOOP
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I)',t) INTO occupied;
    IF occupied THEN RAISE EXCEPTION '020 cannot publish populated Foundation' USING ERRCODE='55000'; END IF;
  END LOOP;
  WITH v1 AS (
    SELECT c.oid,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind='r' AND c.relname NOT IN
      ('empresas','estabelecimentos','memberships','membership_estabelecimentos')
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
    RAISE EXCEPTION '020 V1 structure changed inside migration' USING ERRCODE='55000'; END IF;
END $final$;
COMMIT;
