-- Somente leitura. Confere a guarda. Não altera linha.
DO $$ BEGIN
  IF to_regprocedure('public.kidmais_035_preservar_tabela_publicada()') IS NULL
     OR to_regprocedure('public.kidmais_035_preservar_preco_publicado()') IS NULL THEN
    RAISE EXCEPTION '035 postcheck: função ausente.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'tabelas_preco_publicacao_trg' AND NOT tgisinternal)
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'precos_pacote_tabela_publicada_trg' AND NOT tgisinternal) THEN
    RAISE EXCEPTION '035 postcheck: gatilho de publicação ausente.';
  END IF;
END $$;
SELECT 'pos_035' AS marco, (SELECT count(*) FROM tabelas_preco WHERE publicada_em IS NOT NULL) AS tabelas_publicadas;
