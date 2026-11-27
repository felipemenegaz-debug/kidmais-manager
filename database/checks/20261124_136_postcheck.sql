-- Somente leitura. A 136 criou só marketing_campanhas.destino_externo (boolean NOT NULL DEFAULT false) e a restrição
-- validada kidmais_136_destino_externo_sem_site; nenhum gatilho novo na tabela (só o da 085).
DO $$
DECLARE forma text;
BEGIN
  SET LOCAL search_path = public, pg_catalog;
  -- pg_get_constraintdef sem aspas, qualquer que seja a configuração da sessão (como a 134, Astra r2 P3).
  SET LOCAL quote_all_identifiers = off;
  IF to_regclass('public.marketing_campanhas') IS NULL THEN
    RAISE EXCEPTION '136: marketing_campanhas ausente';
  END IF;
  SELECT COALESCE((SELECT a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull::text
                          || ':' || COALESCE(pg_get_expr(d.adbin, d.adrelid), '')
                     FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                    WHERE a.attrelid = 'public.marketing_campanhas'::regclass AND a.attname = 'destino_externo' AND NOT a.attisdropped), '')
      || '|' ||
         COALESCE((SELECT string_agg(c.conname || ':' || pg_get_constraintdef(c.oid) || ':' || c.convalidated::text, ',' ORDER BY c.conname)
                     FROM pg_constraint c WHERE c.conrelid = 'public.marketing_campanhas'::regclass AND c.conname LIKE 'kidmais\_136\_%'), '')
      || '|' ||
         (SELECT string_agg(t.tgname, ',' ORDER BY t.tgname) FROM pg_trigger t
           WHERE t.tgrelid = 'public.marketing_campanhas'::regclass AND NOT t.tgisinternal)
    INTO forma;
  IF forma IS DISTINCT FROM 'destino_externo:boolean:true:false|kidmais_136_destino_externo_sem_site:CHECK ((NOT (destino_externo AND (site_id IS NOT NULL)))):true|marketing_campanhas_controle' THEN
    RAISE EXCEPTION '136: forma divergente de marketing_campanhas.destino_externo: %', forma;
  END IF;
END $$;
