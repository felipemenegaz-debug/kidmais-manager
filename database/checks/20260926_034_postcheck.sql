-- Somente leitura. Confere a função e os três gatilhos. Não altera linha.
DO $$ BEGIN
  IF to_regprocedure('public.kidmais_034_recusar_empresa_distinta(uuid,uuid,text)') IS NULL THEN
    RAISE EXCEPTION '034 postcheck: função ausente.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'precos_pacote_empresa_trg' AND NOT tgisinternal)
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'pacote_adicionais_empresa_trg' AND NOT tgisinternal)
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'precos_adicional_empresa_trg' AND NOT tgisinternal) THEN
    RAISE EXCEPTION '034 postcheck: gatilho de tenant ausente.';
  END IF;
END $$;
SELECT 'pos_034' AS marco, (SELECT count(*) FROM pacotes WHERE empresa_id IS NULL) AS pacotes_sem_empresa;
