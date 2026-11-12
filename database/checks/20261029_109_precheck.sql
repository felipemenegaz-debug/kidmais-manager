-- Somente leitura. Exige a 075 íntegra nos objetos que a 109 troca e a ausência de qualquer objeto da 109.
-- A conferência completa do retrato da 075 é a da capacidade (lib/assinatura/renovacao-schema.ts), antes da janela.
BEGIN TRANSACTION READ ONLY;
DO $$ BEGIN
  IF to_regclass('public.assinatura_renovacoes') IS NULL THEN RAISE EXCEPTION '109 precheck: 075 ausente'; END IF;
  IF (SELECT count(*) FROM pg_trigger t JOIN pg_proc f ON f.oid = t.tgfoid
      WHERE t.tgrelid = 'public.assinatura_renovacoes'::regclass AND NOT t.tgisinternal AND t.tgenabled = 'O'
        AND f.proname = 'kidmais_075_renovacao_guarda'
        AND t.tgname IN ('assinatura_renovacoes_075_guarda','assinatura_renovacoes_075_truncate')) <> 2
    THEN RAISE EXCEPTION '109 precheck: guardas da 075 ausentes ou desligadas'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.assinatura_renovacoes'::regclass AND conname = 'assinatura_renovacoes_contratacao_id_key')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.assinatura_renovacoes'::regclass AND conname = 'assinatura_renovacoes_estado_check')
    THEN RAISE EXCEPTION '109 precheck: constraints da 075 divergentes'; END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.assinatura_renovacoes'::regclass AND attname = 'substitui_id' AND NOT attisdropped)
     OR to_regprocedure('public.kidmais_109_renovacao_guarda()') IS NOT NULL OR to_regprocedure('public.kidmais_109_renovacao_sucessor()') IS NOT NULL
     OR to_regclass('public.assinatura_renovacoes_109_vigente_uq') IS NOT NULL
    THEN RAISE EXCEPTION '109 precheck: 109 já (parcialmente) presente'; END IF;
END $$;
ROLLBACK;
