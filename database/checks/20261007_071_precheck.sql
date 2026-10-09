-- 071 precheck (somente leitura). Exige 070; 071 ausente.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'adicionais' AND column_name = 'origem_buffet_item_id') THEN
    RAISE EXCEPTION '071 precheck: 070 ausente.';
  END IF;
  IF to_regclass('public.importacoes_comerciais') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'kidmais_071_guarda_importacao') THEN
    RAISE EXCEPTION '071 precheck: já aplicada (total ou parcial).';
  END IF;
  RAISE NOTICE '071 precheck OK: empresas = %', (SELECT count(*) FROM empresas);
END $$;
