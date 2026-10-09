-- 072 precheck (somente leitura). Exige 071; 072 ausente.
DO $$ BEGIN
  IF to_regclass('public.importacoes_comerciais') IS NULL THEN RAISE EXCEPTION '072 precheck: 071 ausente.'; END IF;
  IF to_regclass('public.modelos_contrato_empresa') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'kidmais_072_guarda_modelo') THEN
    RAISE EXCEPTION '072 precheck: já aplicada (total ou parcial).';
  END IF;
  RAISE NOTICE '072 precheck OK: empresas = %', (SELECT count(*) FROM empresas);
END $$;
