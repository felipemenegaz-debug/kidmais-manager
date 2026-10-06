-- 064 precheck (somente leitura). Pré-requisitos: 055d e 061 aplicadas, gatilho de guarda apontando para a 055d, 064 ausente.
DO $$ BEGIN
  IF to_regprocedure('public.kidmais064_contrato_cancelado(uuid)') IS NOT NULL THEN RAISE EXCEPTION '064 precheck: já aplicada.'; END IF;
  IF to_regclass('public.ia_importacoes') IS NULL OR to_regprocedure('public.kidmais_055_importacao_guarda()') IS NULL THEN RAISE EXCEPTION '064 precheck: 055d não aplicada.'; END IF;
  IF to_regclass('public.contrato_importacoes') IS NULL THEN RAISE EXCEPTION '064 precheck: 061 não aplicada.'; END IF;
  IF (SELECT tgfoid FROM pg_trigger WHERE tgrelid = 'public.ia_importacoes'::regclass AND tgname = 'ia_importacoes_055_guarda_trg')
     IS DISTINCT FROM 'public.kidmais_055_importacao_guarda()'::regprocedure THEN
    RAISE EXCEPTION '064 precheck: gatilho de guarda não aponta para a 055d.';
  END IF;
  RAISE NOTICE '064 precheck OK: importações IMPORTADA com contrato cancelado = %',
    (SELECT count(*) FROM ia_importacoes i WHERE i.status = 'IMPORTADA'
       AND EXISTS (SELECT 1 FROM contrato_importacoes ci JOIN contratos c ON c.id = ci.contrato_id WHERE ci.importacao_id = i.id AND c.status = 'CANCELADO'));
END $$;
