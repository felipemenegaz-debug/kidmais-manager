-- 121 precheck PREPARADO, NÃO EXECUTADO. Somente leitura. Exige empresas e a 052 e a ausência de qualquer objeto da 121.
BEGIN TRANSACTION READ ONLY;
SET LOCAL search_path = public, pg_catalog;
DO $$ BEGIN
  IF to_regclass('public.empresas') IS NULL OR to_regclass('public.financeiro_auditoria') IS NULL
    THEN RAISE EXCEPTION '121 precheck: 052 ausente'; END IF;
  IF to_regclass('public.financeiro_aberturas') IS NOT NULL OR to_regclass('public.financeiro_abertura_conferencias') IS NOT NULL
     OR to_regprocedure('public.kidmais_121_somente_acrescimo()') IS NOT NULL
    THEN RAISE EXCEPTION '121 precheck: 121 já (parcialmente) presente'; END IF;
END $$;
SELECT current_database() AS banco, true AS aprovado;
ROLLBACK;
