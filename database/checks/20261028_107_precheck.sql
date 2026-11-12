-- Precheck da 107 (somente leitura): agenda da 005 presente e 107 ausente.
-- A conferência objeto a objeto (canônico × deriva conhecida × recusa) roda dentro da própria migration.
DO $$
BEGIN
  IF to_regclass('public.configuracao_agenda') IS NULL OR to_regclass('public.bloqueios_agenda') IS NULL
     OR to_regprocedure('public.kidmais_set_atualizado_em()') IS NULL OR to_regclass('public.kidmais107_reparos') IS NOT NULL THEN
    RAISE EXCEPTION '107 precheck: agenda da 005 ausente ou 107 já aplicada';
  END IF;
END $$;
