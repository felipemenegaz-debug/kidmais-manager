-- 120 precheck PREPARADO, NÃO EXECUTADO. Somente leitura. Exige a 052 e a ausência de qualquer objeto da 120.
BEGIN TRANSACTION READ ONLY;
SET LOCAL search_path = public, pg_catalog;
DO $$ BEGIN
  IF to_regclass('public.financeiro_entradas_manuais') IS NULL OR to_regclass('public.financeiro_saidas') IS NULL
    THEN RAISE EXCEPTION '120 precheck: 052 ausente'; END IF;
  IF to_regclass('public.financeiro_entradas_liquidacoes') IS NOT NULL OR to_regclass('public.financeiro_saidas_reversoes') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_constraint WHERE conname IN ('financeiro_entradas_manuais_empresa_uk', 'financeiro_saidas_empresa_uk'))
    THEN RAISE EXCEPTION '120 precheck: 120 já (parcialmente) presente'; END IF;
END $$;
SELECT current_database() AS banco,
       (SELECT count(*) FROM financeiro_entradas_manuais) AS entradas_manuais,
       (SELECT count(*) FROM financeiro_saidas) AS saidas,
       true AS aprovado;
ROLLBACK;
