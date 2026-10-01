-- Somente leitura. A tabela empresas precisa permanecer vazia nesta migration.
DO $$ BEGIN
  IF to_regclass('public.empresas') IS NULL
     OR to_regclass('public.estabelecimentos') IS NOT NULL
     OR to_regclass('public.memberships') IS NOT NULL
     OR to_regprocedure('public.kidmais_031_guard_empresas()') IS NULL THEN
    RAISE EXCEPTION '031 postcheck: fundação comercial divergente.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'pacotes'
      AND column_name = 'empresa_id'
      AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION '031 postcheck: empresa_id obrigatório nos pacotes atuais.';
  END IF;
  IF (SELECT count(*) FROM empresas) <> 0 THEN
    RAISE EXCEPTION '031 postcheck: empresas não pode nascer populada.';
  END IF;
  IF EXISTS (SELECT 1 FROM pacotes WHERE empresa_id IS NOT NULL) THEN
    RAISE EXCEPTION '031 postcheck: pacote atual associado sem identidade comprovada.';
  END IF;
END $$;
SELECT 'pos_031' AS marco, (SELECT count(*) FROM empresas) AS empresas, (SELECT count(*) FROM pacotes WHERE empresa_id IS NULL) AS pacotes_sem_empresa;
