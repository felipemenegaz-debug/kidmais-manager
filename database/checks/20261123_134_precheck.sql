-- Somente leitura. A 134 exige a 063 e ainda não pode estar aplicada.
DO $$
BEGIN
  IF to_regclass('public.empresas') IS NULL OR to_regclass('public.plataforma_empresas_cadastro') IS NULL
     OR to_regclass('public.usuarios_administrativos') IS NULL THEN
    RAISE EXCEPTION '134 requer empresas, usuarios_administrativos e a 063';
  END IF;
  IF to_regclass('public.plataforma_empresas_uso') IS NOT NULL THEN
    RAISE EXCEPTION '134 já presente';
  END IF;
END $$;
