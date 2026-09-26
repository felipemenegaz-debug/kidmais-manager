-- Somente leitura. Confere a guarda estrita. Não altera linha.
DO $$ BEGIN
  IF to_regprocedure('public.kidmais_040_falhar_se_incompativel()') IS NULL
     OR to_regprocedure('public.kidmais_038_falhar_se_incompativel()') IS NULL
     OR to_regprocedure('public.kidmais_036_empresa_pai_imutavel()') IS NULL THEN
    RAISE EXCEPTION '040 postcheck: função ausente.';
  END IF;
  IF position('FESTA_LOCAL' IN pg_get_functiondef('public.kidmais_040_falhar_se_incompativel()'::regprocedure)) > 0
     OR position('SALADA_PREMIUM' IN pg_get_functiondef('public.kidmais_040_falhar_se_incompativel()'::regprocedure)) > 0
     OR position('FESTA_LOCAL' IN pg_get_functiondef('public.kidmais_038_falhar_se_incompativel()'::regprocedure)) > 0
     OR position('SALADA_PREMIUM' IN pg_get_functiondef('public.kidmais_038_falhar_se_incompativel()'::regprocedure)) > 0 THEN
    RAISE EXCEPTION '040 postcheck: a guarda ainda lista exceção nominal.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'pacotes_empresa_imutavel_trg' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION '040 postcheck: gatilho do pai ausente.';
  END IF;
END $$;
SELECT 'pos_040' AS marco, (SELECT count(*) FROM pacotes WHERE empresa_id IS NULL) AS pacotes_sem_empresa;
