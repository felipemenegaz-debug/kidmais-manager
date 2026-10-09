-- 071 postcheck (somente leitura). Tabela, índice e gatilho de guarda.
DO $$ BEGIN
  IF to_regclass('public.importacoes_comerciais') IS NULL OR to_regclass('public.importacoes_comerciais_empresa_idx') IS NULL THEN
    RAISE EXCEPTION '071 postcheck: tabela ou índice ausentes.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE NOT tgisinternal AND tgname = 'importacoes_comerciais_071_guarda_trg') THEN
    RAISE EXCEPTION '071 postcheck: gatilho de guarda ausente.';
  END IF;
  RAISE NOTICE '071 postcheck OK: importações = %', (SELECT count(*) FROM importacoes_comerciais);
END $$;
