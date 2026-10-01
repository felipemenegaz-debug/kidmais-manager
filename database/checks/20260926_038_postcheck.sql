-- Somente leitura. Confere o marcador e os gatilhos do pai. Não altera linha.
DO $$ BEGIN
  IF to_regprocedure('public.kidmais_038_falhar_se_incompativel()') IS NULL
     OR to_regprocedure('public.kidmais_036_empresa_pai_imutavel()') IS NULL THEN
    RAISE EXCEPTION '038 postcheck: função ausente.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'pacotes_empresa_imutavel_trg' AND NOT tgisinternal)
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'tabelas_preco_empresa_imutavel_trg' AND NOT tgisinternal)
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'adicionais_empresa_imutavel_trg' AND NOT tgisinternal) THEN
    RAISE EXCEPTION '038 postcheck: gatilho do pai ausente.';
  END IF;
END $$;
SELECT 'pos_038' AS marco, (SELECT count(*) FROM pacotes WHERE empresa_id IS NULL) AS pacotes_sem_empresa;
