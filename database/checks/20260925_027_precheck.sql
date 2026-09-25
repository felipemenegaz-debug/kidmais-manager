-- Somente leitura. Não executa a migration.
DO $$ BEGIN
  IF to_regclass('public.perfil_empresas') IS NULL
     OR to_regclass('public.perfil_unidades') IS NULL THEN
    RAISE EXCEPTION '027: estrutura 026 ausente';
  END IF;
  IF to_regclass('public.perfil_empresa_revisoes') IS NOT NULL THEN
    RAISE EXCEPTION '027: cadastro já existe';
  END IF;
END $$;
