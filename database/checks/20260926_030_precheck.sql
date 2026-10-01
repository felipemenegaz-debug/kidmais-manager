-- Somente leitura. Não aplica a 030.
DO $$ BEGIN
  IF to_regclass('public.precos_pacote') IS NULL
     OR to_regclass('public.precos_adicional') IS NULL
     OR to_regclass('public.fechamento_pacote_snapshots') IS NULL
     OR to_regclass('public.fechamento_revisoes') IS NULL
     OR to_regclass('public.fechamento_revisao_adicionais') IS NULL THEN
    RAISE EXCEPTION '030 precheck: preço ou referência histórica ausente.';
  END IF;
  IF to_regprocedure('public.kidmais_030_preco_utilizado()') IS NOT NULL THEN
    RAISE EXCEPTION '030 precheck: proteção já aplicada.';
  END IF;
END $$;
SELECT 'pre_030' AS marco, (SELECT count(*) FROM precos_pacote) AS precos_pacote;
