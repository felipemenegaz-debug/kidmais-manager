DO $$ BEGIN
  IF to_regprocedure('public.kidmais_043_guard_memberships()') IS NULL
     OR to_regprocedure('public.kidmais_045_guard_memberships()') IS NULL THEN
    RAISE EXCEPTION '045 postcheck: função antiga ou nova ausente.';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM pg_trigger g
      JOIN pg_proc p ON p.oid = g.tgfoid
     WHERE g.tgname = 'kidmais_043_memberships_guard_trg'
       AND NOT g.tgisinternal
       AND p.proname = 'kidmais_045_guard_memberships'
  ) THEN
    RAISE EXCEPTION '045 postcheck: o gatilho não aponta para o ciclo novo.';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'kidmais_043_memberships_status_ck'
       AND pg_get_constraintdef(oid) LIKE '%SUSPENSA%'
  ) THEN
    RAISE EXCEPTION '045 postcheck: membership não tem status SUSPENSA.';
  END IF;
END $$;

SELECT 'pos_045' AS marco, (SELECT count(*) FROM memberships) AS memberships;
