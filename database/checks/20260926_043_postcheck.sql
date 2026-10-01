-- Somente leitura. Confere a estrutura. Não ativa membership nem associa pacote.
DO $$ BEGIN
  IF to_regclass('public.estabelecimentos') IS NULL
     OR to_regclass('public.memberships') IS NULL
     OR to_regclass('public.membership_estabelecimentos') IS NULL
     OR to_regclass('public.empresas') IS NULL THEN
    RAISE EXCEPTION '043 postcheck: tabela ausente.';
  END IF;
  IF to_regprocedure('public.kidmais_043_guard_memberships()') IS NULL
     OR to_regprocedure('public.kidmais_043_guard_estabelecimentos()') IS NULL
     OR to_regprocedure('public.kidmais_043_guard_membership_estabelecimentos()') IS NULL THEN
    RAISE EXCEPTION '043 postcheck: guarda ausente.';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'memberships'
       AND column_name = 'papel'
  ) THEN
    RAISE EXCEPTION '043 postcheck: membership não tem papel.';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'kidmais_043_memberships_status_ck'
       AND pg_get_constraintdef(oid) LIKE '%SUSPENSA%'
  ) THEN
    RAISE EXCEPTION '043 postcheck: membership não tem status SUSPENSA.';
  END IF;
  IF position('PENDENTE' IN pg_get_functiondef('public.kidmais_043_guard_memberships()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION '043 postcheck: a membership nova não fica presa em PENDENTE.';
  END IF;
END $$;

SELECT 'pos_043' AS marco,
       (SELECT count(*) FROM pacotes WHERE empresa_id IS NULL) AS pacotes_sem_empresa;
