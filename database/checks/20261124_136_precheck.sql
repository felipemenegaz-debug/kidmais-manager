-- Somente leitura. A 136 exige a 085 (marketing_campanhas com site_id) e ainda não pode estar aplicada.
DO $$
BEGIN
  IF to_regclass('public.marketing_campanhas') IS NULL OR NOT EXISTS (
       SELECT 1 FROM pg_attribute WHERE attrelid = 'public.marketing_campanhas'::regclass AND attname = 'site_id' AND NOT attisdropped) THEN
    RAISE EXCEPTION '136 requer marketing_campanhas.site_id (085)';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.marketing_campanhas'::regclass AND attname = 'destino_externo' AND NOT attisdropped) THEN
    RAISE EXCEPTION '136 já presente';
  END IF;
END $$;
