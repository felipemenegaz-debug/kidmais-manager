-- Precheck da 104 (somente leitura): 094 presente, 104 ausente e função de hash com o corpo exato da 016.
DO $$
DECLARE f record;
BEGIN
  IF to_regclass('public.fechamento_revisoes') IS NULL OR NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.fechamento_revisoes'::regclass
       AND attname = 'salao_id' AND NOT attisdropped) THEN
    RAISE EXCEPTION '104 precheck: 094 ausente';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.fechamento_revisoes'::regclass AND attname = 'hash_versao' AND NOT attisdropped)
     OR to_regprocedure('public.kidmais104_hash_versao_imutavel()') IS NOT NULL THEN
    RAISE EXCEPTION '104 precheck: já aplicada ou parcial';
  END IF;
  SELECT * INTO f FROM (SELECT encode(sha256(convert_to(replace(p.prosrc, chr(13), ''), 'UTF8')), 'hex') AS corpo, p.prolang = (SELECT oid FROM pg_language WHERE lanname = 'sql') AS sql_lang,
             p.provolatile::text AS vol, p.proconfig IS NULL AS sem_config, NOT p.prosecdef AS invoker, p.prorettype = 'text'::regtype AS ret,
             p.prokind::text AS kind
        FROM pg_proc p WHERE p.oid = to_regprocedure('public.kidmais_hash_revisao_operacional(uuid)')) x;
  IF f.corpo IS NULL OR NOT (f.corpo = '9986a2a6bad41a28ac036c8e59b6358e6f75bda680781c97896eff180bed940f' AND f.sql_lang AND f.vol = 's' AND f.sem_config AND f.invoker AND f.ret AND f.kind = 'f') THEN
    RAISE EXCEPTION '104 precheck: kidmais_hash_revisao_operacional diferente da 016';
  END IF;
END $$;
