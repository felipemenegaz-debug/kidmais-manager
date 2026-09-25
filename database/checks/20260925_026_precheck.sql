-- Somente leitura. Instalação ainda não aplicada.
-- Não executa a migration e não altera usuários, preços ou concessões.
DO $$ BEGIN
  IF to_regclass('public.usuarios_administrativos') IS NULL THEN
    RAISE EXCEPTION '026: usuarios_administrativos ausente';
  END IF;
  IF to_regclass('public.perfil_empresas') IS NOT NULL
     OR to_regclass('public.perfil_unidades') IS NOT NULL
     OR to_regclass('public.perfil_empresa_concessoes') IS NOT NULL THEN
    RAISE EXCEPTION '026: estruturas já existem';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.festa_usuario_capacidades'::regclass
      AND pg_get_constraintdef(oid) ~ 'PERFIL_'
  ) THEN
    RAISE EXCEPTION '026: capacidades de Festa não podem receber o perfil';
  END IF;
END $$;
