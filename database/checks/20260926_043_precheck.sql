-- A 043 exige a empresas da linha comercial e a ausência das três tabelas novas.
-- Não exige 63 tabelas, hash v1, runtime_roles nem a ausência de empresas.
DO $$ BEGIN
  IF to_regclass('public.empresas') IS NULL
     OR to_regclass('public.usuarios_administrativos') IS NULL THEN
    RAISE EXCEPTION '043 precheck: empresas canônica ou usuários administrativos ausentes.';
  END IF;
  IF to_regclass('public.estabelecimentos') IS NOT NULL
     OR to_regclass('public.memberships') IS NOT NULL
     OR to_regclass('public.membership_estabelecimentos') IS NOT NULL THEN
    RAISE EXCEPTION '043 precheck: estrutura de tenant já existe.';
  END IF;
END $$;

SELECT 'pre_043' AS marco,
       (SELECT count(*) FROM empresas) AS empresas,
       (SELECT count(*) FROM pacotes WHERE empresa_id IS NULL) AS pacotes_sem_empresa;
