-- PREPARADO, NÃO EXECUTADO. Somente leitura.
BEGIN TRANSACTION READ ONLY;
DO $$ BEGIN
  IF to_regclass('public.assinatura_contratacoes') IS NULL OR to_regclass('public.assinatura_fundadores') IS NULL
     OR to_regclass('public.assinatura_isencoes') IS NULL THEN RAISE EXCEPTION '075 exige 074 instalada.'; END IF;
  IF to_regclass('public.assinatura_renovacoes') IS NOT NULL OR to_regprocedure('public.kidmais_075_renovacao_guarda()') IS NOT NULL
    THEN RAISE EXCEPTION '075 já instalada total ou parcialmente.'; END IF;
END $$;
ROLLBACK;
