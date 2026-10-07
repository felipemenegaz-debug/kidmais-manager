-- 072 postcheck (somente leitura). Tabela, índice de ativo único e gatilho de guarda.
DO $$ BEGIN
  IF to_regclass('public.modelos_contrato_empresa') IS NULL OR to_regclass('public.modelos_contrato_empresa_ativo_uk') IS NULL THEN
    RAISE EXCEPTION '072 postcheck: tabela ou índice ausentes.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE NOT tgisinternal AND tgname = 'modelos_contrato_empresa_072_guarda_trg') THEN
    RAISE EXCEPTION '072 postcheck: gatilho de guarda ausente.';
  END IF;
  RAISE NOTICE '072 postcheck OK: modelos = %', (SELECT count(*) FROM modelos_contrato_empresa);
END $$;
