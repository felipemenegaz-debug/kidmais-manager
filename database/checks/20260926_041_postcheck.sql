-- Somente leitura. Confere o gatilho da revisão. Não altera linha.
DO $$ BEGIN
  IF to_regprocedure('public.kidmais_041_revisao_mesmo_tenant()') IS NULL
     OR to_regprocedure('public.kidmais_041_falhar_se_revisao_cruzada()') IS NULL THEN
    RAISE EXCEPTION '041 postcheck: função ausente.';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM pg_trigger
     WHERE tgname = 'pacotes_revisao_tenant_trg'
       AND NOT tgisinternal
       AND tgenabled <> 'D'
  ) THEN
    RAISE EXCEPTION '041 postcheck: gatilho de revisão ausente.';
  END IF;
END $$;
SELECT 'pos_041' AS marco, (SELECT count(*) FROM pacotes WHERE revisao_anterior_id IS NOT NULL) AS revisoes;
