-- Somente leitura. Não executa a migration.
DO $$ BEGIN
  IF current_schema() IS DISTINCT FROM 'public' AND NOT EXISTS (
    SELECT 1 FROM information_schema.schemata WHERE schema_name = 'public'
  ) THEN
    RAISE EXCEPTION '028: schema public ausente';
  END IF;
  IF to_regclass('public.perfil_empresas') IS NULL
     OR to_regclass('public.perfil_unidades') IS NULL
     OR to_regclass('public.perfil_empresa_revisoes') IS NULL THEN
    RAISE EXCEPTION '028: estrutura 026/027 ausente';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'perfil_empresa_revisoes' AND column_name = 'aplicado_por'
  ) THEN
    RAISE EXCEPTION '028: coluna aplicado_por já existe';
  END IF;
END $$;
