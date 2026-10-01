-- Somente leitura. Confere a trava e o gatilho de exclusão. Não altera linha.
DO $$ BEGIN
  IF to_regprocedure('public.kidmais_037_trava_publicacao(uuid)') IS NULL THEN
    RAISE EXCEPTION '037 postcheck: trava ausente.';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM pg_trigger
     WHERE tgname = 'precos_pacote_tabela_publicada_trg'
       AND NOT tgisinternal
       AND (tgtype & 8) = 8
  ) THEN
    RAISE EXCEPTION '037 postcheck: exclusão de preço publicado não está no gatilho.';
  END IF;
END $$;
SELECT 'pos_037' AS marco, (SELECT count(*) FROM tabelas_preco WHERE publicada_em IS NOT NULL) AS tabelas_publicadas;
