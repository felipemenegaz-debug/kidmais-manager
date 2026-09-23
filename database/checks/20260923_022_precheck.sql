-- Somente leitura; executar apenas em clone isolado autorizado.
DO $$ BEGIN
  IF to_regclass('public.buffet_categorias') IS NULL OR
     to_regclass('public.buffet_itens') IS NULL OR
     to_regclass('public.pacote_buffet_categorias') IS NULL THEN
    RAISE EXCEPTION 'Estrutura 021 ausente.';
  END IF;
  IF EXISTS (SELECT 1 FROM buffet_categorias WHERE codigo='SALGADOS') THEN
    RAISE EXCEPTION 'Seed 022 já presente; conferir histórico.';
  END IF;
END $$;
SELECT 'pre_022' AS marco,(SELECT count(*) FROM fechamentos) AS fechamentos;
