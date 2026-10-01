DO $$ BEGIN
  IF to_regprocedure('public.kidmais_031_guard_empresas()') IS NULL
     OR to_regclass('public.empresas') IS NULL
     OR to_regclass('public.auditoria') IS NULL THEN
    RAISE EXCEPTION '044 precheck: guard da 031, empresas ou auditoria ausente.';
  END IF;
  IF to_regprocedure('public.kidmais_044_guard_empresas()') IS NOT NULL THEN
    RAISE EXCEPTION '044 precheck: ciclo da empresa já instalado.';
  END IF;
END $$;

SELECT 'pre_044' AS marco, (SELECT count(*) FROM empresas) AS empresas;
