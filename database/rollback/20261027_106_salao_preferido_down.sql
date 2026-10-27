-- Rollback da 106. Só com autorização própria. Recusado (nada alterado) se QUALQUER festa tiver salão de preferência
-- gravado, ou se a estrutura não for exatamente a da 106 (mesma conferência do postcheck).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
SET LOCAL search_path = public, pg_catalog;
LOCK TABLE public.fechamentos IN SHARE ROW EXCLUSIVE MODE;
DO $$
BEGIN
  IF NOT ((SELECT count(*) FROM pg_attribute a WHERE a.attrelid = 'public.fechamentos'::regclass AND a.attname = 'salao_preferido_id' AND NOT a.attisdropped
          AND a.atttypid = 'uuid'::regtype AND NOT a.attnotnull AND NOT a.atthasdef) = 1
     AND (SELECT count(*) FROM pg_constraint c WHERE c.conrelid = 'public.fechamentos'::regclass AND c.conname = 'fechamentos_106_salao_preferido_fk'
          AND c.contype = 'f' AND c.confrelid = 'public.agenda_saloes'::regclass AND c.confupdtype = 'r' AND c.confdeltype = 'r'
          AND c.confmatchtype = 's' AND NOT c.condeferrable AND NOT c.condeferred AND c.convalidated
          AND (SELECT array_agg(a.attname::text ORDER BY k.n) FROM unnest(c.conkey) WITH ORDINALITY k(attnum, n) JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum)
              = ARRAY['empresa_id', 'salao_preferido_id']
          AND (SELECT array_agg(a.attname::text ORDER BY k.n) FROM unnest(c.confkey) WITH ORDINALITY k(attnum, n) JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum)
              = ARRAY['empresa_id', 'id']) = 1
     AND (SELECT count(*) FROM pg_index i WHERE i.indexrelid = to_regclass('public.fechamentos_106_salao_preferido_idx') AND i.indrelid = 'public.fechamentos'::regclass
          AND NOT i.indisunique AND i.indisvalid AND i.indisready AND i.indnatts = 1
          AND i.indkey[0] = (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.fechamentos'::regclass AND attname = 'salao_preferido_id')
          AND regexp_replace(pg_get_expr(i.indpred, i.indrelid), '[()\s]', '', 'g') = 'salao_preferido_idISNOTNULL') = 1
     AND (SELECT count(*) FROM pg_proc p WHERE p.oid = to_regprocedure('public.kidmais106_salao_preferido_escopo()') AND p.pronamespace = 'public'::regnamespace
           AND p.prolang = (SELECT oid FROM pg_language WHERE lanname = 'plpgsql') AND p.provolatile = 'v' AND NOT p.prosecdef
           AND p.prorettype = 'trigger'::regtype AND p.proconfig = ARRAY['search_path=public, pg_catalog']
           AND encode(sha256(convert_to(replace(p.prosrc, chr(13), ''), 'UTF8')), 'hex') = '1e6d43d03d39cff9eabe02149c881666bc8b120557aa5650a8ce1b954955a231') = 1
     AND (SELECT count(*) FROM pg_proc p WHERE p.oid = to_regprocedure('public.kidmais106_salao_escopo_referenciado()') AND p.pronamespace = 'public'::regnamespace
           AND p.prolang = (SELECT oid FROM pg_language WHERE lanname = 'plpgsql') AND p.provolatile = 'v' AND NOT p.prosecdef
           AND p.prorettype = 'trigger'::regtype AND p.proconfig = ARRAY['search_path=public, pg_catalog']
           AND encode(sha256(convert_to(replace(p.prosrc, chr(13), ''), 'UTF8')), 'hex') = 'a3684094f18048377a1cccd4ff81de80a4649fe675f07cadd1e24c515e87c5b4') = 1
     AND (SELECT count(*) FROM pg_trigger t
          WHERE t.tgrelid = 'public.fechamentos'::regclass AND t.tgname = 'fechamentos_106_salao_preferido_trg' AND NOT t.tgisinternal AND t.tgenabled = 'O'
            AND t.tgtype = 23 AND t.tgqual IS NULL AND t.tgnargs = 0 AND t.tgconstraint = 0 AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL
            AND t.tgfoid = to_regprocedure('public.kidmais106_salao_preferido_escopo()')
            AND (SELECT array_agg(a.attname::text ORDER BY a.attname) FROM unnest(t.tgattr::int2[]) k JOIN pg_attribute a ON a.attrelid = t.tgrelid AND a.attnum = k)
                = ARRAY['empresa_id', 'estabelecimento_id', 'salao_preferido_id']) = 1
     AND (SELECT count(*) FROM pg_trigger t
          WHERE t.tgrelid = 'public.agenda_saloes'::regclass AND t.tgname = 'agenda_saloes_106_escopo_trg' AND NOT t.tgisinternal AND t.tgenabled = 'O'
            AND t.tgtype = 19 AND t.tgqual IS NULL AND t.tgnargs = 0 AND t.tgconstraint = 0 AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL
            AND t.tgfoid = to_regprocedure('public.kidmais106_salao_escopo_referenciado()')
            AND (SELECT array_agg(a.attname::text ORDER BY a.attname) FROM unnest(t.tgattr::int2[]) k JOIN pg_attribute a ON a.attrelid = t.tgrelid AND a.attnum = k)
                = ARRAY['empresa_id', 'estabelecimento_id']) = 1) THEN
    RAISE EXCEPTION '106 rollback: estrutura diferente da 106; nada alterado';
  END IF;
  IF EXISTS (SELECT 1 FROM public.fechamentos WHERE salao_preferido_id IS NOT NULL) THEN
    RAISE EXCEPTION '106 rollback: há festa com salão de preferência; nada alterado';
  END IF;
END $$;
DROP TRIGGER agenda_saloes_106_escopo_trg ON public.agenda_saloes;
DROP FUNCTION public.kidmais106_salao_escopo_referenciado();
DROP TRIGGER fechamentos_106_salao_preferido_trg ON public.fechamentos;
DROP FUNCTION public.kidmais106_salao_preferido_escopo();
DROP INDEX public.fechamentos_106_salao_preferido_idx;
ALTER TABLE public.fechamentos DROP CONSTRAINT fechamentos_106_salao_preferido_fk;
ALTER TABLE public.fechamentos DROP COLUMN salao_preferido_id;
DO $$
BEGIN
  IF NOT (to_regclass('public.agenda_salao_fotos') IS NOT NULL
     AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.fechamentos'::regclass AND attname = 'salao_id' AND NOT attisdropped)
     AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.agenda_saloes'::regclass AND conname = 'agenda_saloes_empresa_id_uk' AND contype = 'u')
     AND NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.fechamentos'::regclass AND attname = 'salao_preferido_id' AND NOT attisdropped)
     AND to_regprocedure('public.kidmais106_salao_preferido_escopo()') IS NULL
     AND to_regprocedure('public.kidmais106_salao_escopo_referenciado()') IS NULL
     AND to_regclass('public.fechamentos_106_salao_preferido_idx') IS NULL) THEN
    RAISE EXCEPTION '106 rollback: resíduo depois da remoção';
  END IF;
END $$;
COMMIT;
