DO $$ BEGIN
  IF to_regprocedure('public.kidmais_043_guard_memberships()') IS NULL
     OR to_regclass('public.memberships') IS NULL THEN
    RAISE EXCEPTION '045 precheck: guard da 043 ou memberships ausente.';
  END IF;
  IF to_regprocedure('public.kidmais_045_guard_memberships()') IS NOT NULL THEN
    RAISE EXCEPTION '045 precheck: ciclo da membership já instalado.';
  END IF;
END $$;

SELECT 'pre_045' AS marco, (SELECT count(*) FROM memberships) AS memberships;
