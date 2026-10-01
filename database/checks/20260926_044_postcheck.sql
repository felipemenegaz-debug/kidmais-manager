DO $$ BEGIN
  IF to_regprocedure('public.kidmais_031_guard_empresas()') IS NULL
     OR to_regprocedure('public.kidmais_044_guard_empresas()') IS NULL THEN
    RAISE EXCEPTION '044 postcheck: função antiga ou nova ausente.';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM pg_trigger g
      JOIN pg_proc p ON p.oid = g.tgfoid
     WHERE g.tgname = 'empresas_guard_trg'
       AND NOT g.tgisinternal
       AND p.proname = 'kidmais_044_guard_empresas'
  ) THEN
    RAISE EXCEPTION '044 postcheck: o gatilho não aponta para o ciclo novo.';
  END IF;
END $$;

SELECT 'pos_044' AS marco, (SELECT count(*) FROM empresas) AS empresas;
