-- Somente leitura. Não altera linhas de preço.
DO $$ BEGIN
  IF to_regprocedure('public.kidmais_030_preco_utilizado()') IS NULL THEN
    RAISE EXCEPTION '030 postcheck: função ausente.';
  END IF;
  IF (
    SELECT count(*) FROM pg_trigger
    WHERE tgname IN (
      'precos_pacote_calculo_utilizado_trg',
      'precos_adicional_calculo_utilizado_trg'
    ) AND NOT tgisinternal
  ) <> 2 THEN
    RAISE EXCEPTION '030 postcheck: gatilho de preço utilizado ausente.';
  END IF;
  IF to_regprocedure('public.kidmais_set_atualizado_em()') IS NULL THEN
    RAISE EXCEPTION '030 postcheck: atualizado_em foi removido.';
  END IF;
END $$;
SELECT 'pos_030' AS marco, (SELECT count(*) FROM precos_pacote) AS precos_pacote;
