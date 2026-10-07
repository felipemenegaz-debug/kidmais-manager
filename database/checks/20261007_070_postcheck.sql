-- 070 postcheck (somente leitura). Colunas, índices únicos e categorias de adicional.
DO $$ BEGIN
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'adicionais'
         AND column_name IN ('origem_buffet_item_id', 'origem_buffet_categoria_id', 'escolhas_max')) <> 3 THEN
    RAISE EXCEPTION '070 postcheck: colunas ausentes.';
  END IF;
  IF to_regclass('public.adicionais_empresa_origem_item_uk') IS NULL OR to_regclass('public.adicionais_empresa_origem_categoria_uk') IS NULL THEN
    RAISE EXCEPTION '070 postcheck: índices únicos ausentes.';
  END IF;
  IF (SELECT count(*) FROM adicional_categorias WHERE codigo IN ('BUFFET', 'MESA', 'DECORACAO', 'EXTRA', 'BEBIDA', 'COMBO')) <> 6 THEN
    RAISE EXCEPTION '070 postcheck: categorias de adicional ausentes.';
  END IF;
  RAISE NOTICE '070 postcheck OK: adicionais do buffet = %',
    (SELECT count(*) FROM adicionais WHERE origem_buffet_item_id IS NOT NULL OR origem_buffet_categoria_id IS NOT NULL);
END $$;
