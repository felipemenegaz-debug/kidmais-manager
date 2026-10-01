-- Somente leitura. A migration não substitui tabela e não altera publicação.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'tabelas_preco' AND column_name = 'substituida_em'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'tabelas_preco' AND column_name = 'substituida_por_id'
  ) OR to_regprocedure('public.kidmais_048_recusar_ciclo(uuid,uuid)') IS NULL
    OR to_regprocedure('public.kidmais_048_validar_supersessao_fim()') IS NULL THEN
    RAISE EXCEPTION '048 postcheck: supersessão ausente.';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM pg_trigger
     WHERE tgname = 'tabelas_preco_supersessao_fim_trg'
       AND tgdeferrable
       AND tginitdeferred
       AND tgenabled <> 'D'
  ) THEN
    RAISE EXCEPTION '048 postcheck: a validação final da sucessora não é deferred.';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pg_proc
     WHERE proname = 'kidmais_035_preservar_tabela_publicada'
       AND (
         pg_get_functiondef(oid) NOT LIKE '%kidmais_047_lacunas_escopo%'
         OR pg_get_functiondef(oid) NOT LIKE '%substituida_em IS NULL%'
       )
  ) THEN
    RAISE EXCEPTION '048 postcheck: a publicação corrente não ignora tabela já substituída.';
  END IF;
  IF EXISTS (SELECT 1 FROM tabelas_preco WHERE substituida_em IS NOT NULL) THEN
    RAISE EXCEPTION '048 postcheck: a migration não pode substituir tabela.';
  END IF;
END $$;

SELECT 'pos_048' AS marco,
       (SELECT count(*) FROM tabelas_preco WHERE publicada_em IS NOT NULL) AS tabelas_publicadas,
       (SELECT count(*) FROM tabelas_preco WHERE substituida_em IS NOT NULL) AS substituidas;
