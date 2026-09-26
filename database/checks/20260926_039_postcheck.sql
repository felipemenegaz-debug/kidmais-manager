-- Somente leitura. Confere a trava do par e o gatilho AFTER. Não altera linha.
DO $$ BEGIN
  IF to_regprocedure('public.kidmais_039_travar_par(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION '039 postcheck: trava do par ausente.';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM pg_trigger
     WHERE tgname = 'precos_pacote_tabela_publicada_trg'
       AND NOT tgisinternal
       AND (tgtype & 2) = 2
       AND (tgtype & 8) = 8
  ) OR NOT EXISTS (
    SELECT 1
      FROM pg_trigger
     WHERE tgname = 'precos_pacote_tabela_publicada_depois_trg'
       AND NOT tgisinternal
       AND (tgtype & 2) = 0
       AND (tgtype & 4) = 4
       AND (tgtype & 8) = 8
       AND (tgtype & 16) = 16
  ) THEN
    RAISE EXCEPTION '039 postcheck: gatilho de preço publicado ausente.';
  END IF;
END $$;
SELECT 'pos_039' AS marco, (SELECT count(*) FROM tabelas_preco WHERE publicada_em IS NOT NULL) AS tabelas_publicadas;
