-- Somente leitura. Confere a releitura da faixa. Não altera linha.
DO $$ BEGIN
  IF to_regprocedure('public.kidmais_042_revalidar_faixa_publicada(uuid,uuid,uuid,text,integer,integer)') IS NULL
     OR to_regprocedure('public.kidmais_042_falhar_se_faixa_publicada_sobreposta()') IS NULL THEN
    RAISE EXCEPTION '042 postcheck: função ausente.';
  END IF;
  IF position(
       'kidmais_042_revalidar_faixa_publicada'
       IN pg_get_functiondef('public.kidmais_035_preservar_preco_publicado()'::regprocedure)
     ) = 0 THEN
    RAISE EXCEPTION '042 postcheck: o preço publicado não relê a faixa depois da trava.';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM pg_trigger
     WHERE tgname = 'precos_pacote_tabela_publicada_depois_trg'
       AND NOT tgisinternal
       AND tgenabled <> 'D'
  ) THEN
    RAISE EXCEPTION '042 postcheck: gatilho AFTER ausente.';
  END IF;
END $$;
SELECT 'pos_042' AS marco, (SELECT count(*) FROM tabelas_preco WHERE publicada_em IS NOT NULL) AS tabelas_publicadas;
