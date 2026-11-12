-- Integridade da 104 (somente leitura, SÓ CATÁLOGO; plano do aplicador 104+106 rev. 2, parecer do Astra de 27/10/2026):
-- as verificações estruturais do postcheck, sem ler dados — corpo e metadados da função de hash (sha fe0f0199…, LANGUAGE sql,
-- STABLE, SECURITY INVOKER, sem proconfig, retorno text, função), coluna hash_versao (smallint NOT NULL DEFAULT 1), CHECK
-- exato e gatilho kidmais104_hash_versao_imutavel (BEFORE UPDATE, função VOLATILE com search_path e corpo 182ead96…).
-- A auditoria de DADOS (revisão aberta com hash divergente) continua no 20261027_104_postcheck.sql.
-- Derivado de database/checks/20261027_104_postcheck.sql; mensagens com prefixo 104 integridade.
DO $$
DECLARE f record;
BEGIN
  SELECT * INTO f FROM (SELECT encode(sha256(convert_to(replace(p.prosrc, chr(13), ''), 'UTF8')), 'hex') AS corpo, p.prolang = (SELECT oid FROM pg_language WHERE lanname = 'sql') AS sql_lang,
             p.provolatile::text AS vol, p.proconfig IS NULL AS sem_config, NOT p.prosecdef AS invoker, p.prorettype = 'text'::regtype AS ret,
             p.prokind::text AS kind
        FROM pg_proc p WHERE p.oid = to_regprocedure('public.kidmais_hash_revisao_operacional(uuid)')) x;
  IF f.corpo IS NULL OR NOT (f.corpo = 'fe0f0199883b0c9d994478a2aba4e92940bea0f52250ef2ea62462900615f6ed' AND f.sql_lang AND f.vol = 's' AND f.sem_config AND f.invoker AND f.ret AND f.kind = 'f') THEN
    RAISE EXCEPTION '104 integridade: corpo da função de hash';
  END IF;
  IF NOT (EXISTS (SELECT 1 FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                 WHERE a.attrelid = 'public.fechamento_revisoes'::regclass AND a.attname = 'hash_versao' AND NOT a.attisdropped
                   AND a.atttypid = 'smallint'::regtype AND a.attnotnull AND pg_get_expr(d.adbin, d.adrelid) = '1')
     AND (SELECT count(*) FROM pg_constraint c WHERE c.conrelid = 'public.fechamento_revisoes'::regclass AND c.contype = 'c'
            AND c.conname = 'fechamento_revisoes_hash_versao_ck' AND c.convalidated AND NOT c.connoinherit
            AND pg_get_constraintdef(c.oid) = 'CHECK ((hash_versao = ANY (ARRAY[1, 2])))'
            AND c.conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = 'public.fechamento_revisoes'::regclass AND attname = 'hash_versao')]::int2[]) = 1
     AND EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
                 WHERE t.tgrelid = 'public.fechamento_revisoes'::regclass AND t.tgname = 'kidmais104_hash_versao_imutavel' AND NOT t.tgisinternal
                   AND t.tgenabled = 'O' AND t.tgtype = 19 AND t.tgattr::text = '' AND t.tgqual IS NULL AND t.tgnargs = 0
                   AND t.tgconstraint = 0 AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL
                   AND p.oid = to_regprocedure('public.kidmais104_hash_versao_imutavel()') AND p.pronamespace = 'public'::regnamespace
                   AND p.prolang = (SELECT oid FROM pg_language WHERE lanname = 'plpgsql') AND p.provolatile = 'v' AND NOT p.prosecdef
                   AND p.proconfig = ARRAY['search_path=public, pg_catalog']
                   AND encode(sha256(convert_to(replace(p.prosrc, chr(13), ''), 'UTF8')), 'hex') = '182ead96ac34a0abcd6251d500bb3b5705657301fe915a6addd19f82b432ec85')) THEN
    RAISE EXCEPTION '104 integridade: coluna, restrição ou gatilho de hash_versao';
  END IF;
END $$;
