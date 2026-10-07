-- 064 postcheck (somente leitura). Funções presentes, gatilho reapontado, 055d preservada para rollback.
DO $$ BEGIN
  IF to_regprocedure('public.kidmais064_contrato_cancelado(uuid)') IS NULL OR to_regprocedure('public.kidmais_064_importacao_guarda()') IS NULL THEN
    RAISE EXCEPTION '064 postcheck: funções ausentes.';
  END IF;
  IF to_regprocedure('public.kidmais_055_importacao_guarda()') IS NULL THEN RAISE EXCEPTION '064 postcheck: guarda da 055d removida (rollback impossível).'; END IF;
  IF (SELECT tgfoid FROM pg_trigger WHERE tgrelid = 'public.ia_importacoes'::regclass AND tgname = 'ia_importacoes_055_guarda_trg')
     IS DISTINCT FROM 'public.kidmais_064_importacao_guarda()'::regprocedure THEN
    RAISE EXCEPTION '064 postcheck: gatilho de guarda não aponta para a 064.';
  END IF;
  RAISE NOTICE '064 postcheck OK: importações = %, descartadas com substituição = %',
    (SELECT count(*) FROM ia_importacoes), (SELECT count(*) FROM ia_importacoes WHERE dados ? 'substituicao');
END $$;
