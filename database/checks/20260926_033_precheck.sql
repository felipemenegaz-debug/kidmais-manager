-- Somente leitura. Não aplica a 033.
DO $$ BEGIN
  IF to_regclass('public.tabelas_preco') IS NULL THEN
    RAISE EXCEPTION '033 precheck: tabelas de preço ausentes.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'tabelas_preco' AND column_name = 'publicada_em'
  ) THEN
    RAISE EXCEPTION '033 precheck: publicação já aplicada.';
  END IF;
END $$;
SELECT 'pre_033' AS marco, (SELECT count(*) FROM tabelas_preco) AS tabelas;
