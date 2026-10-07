-- 070 precheck (somente leitura). Exige 021 e 031; 070 ausente.
DO $$ BEGIN
  IF to_regclass('public.adicional_categorias') IS NULL OR to_regclass('public.buffet_itens') IS NULL
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = 'public' AND table_name = 'adicionais' AND column_name = 'empresa_id') THEN
    RAISE EXCEPTION '070 precheck: 021 ou 031 ausentes.';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'adicionais'
                AND column_name IN ('origem_buffet_item_id', 'origem_buffet_categoria_id', 'escolhas_max')) THEN
    RAISE EXCEPTION '070 precheck: já aplicada (total ou parcial).';
  END IF;
  RAISE NOTICE '070 precheck OK: adicionais = %, itens do buffet = %', (SELECT count(*) FROM adicionais), (SELECT count(*) FROM buffet_itens);
END $$;
