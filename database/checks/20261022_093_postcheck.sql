-- Somente leitura. Confirma a 093: tabelas novas, colunas com padrão neutro e guarda de empresa.
DO $$
BEGIN
  IF to_regclass('public.agenda_escopo_config') IS NULL OR to_regclass('public.agenda_saloes') IS NULL
    OR to_regclass('public.configuracao_agenda_saloes') IS NULL OR to_regclass('public.pacote_saloes') IS NULL
    OR to_regclass('public.agenda_escopo_config_escopo_uk') IS NULL
    OR to_regprocedure('public.kidmais093_mesma_empresa()') IS NULL THEN
    RAISE EXCEPTION '093 postcheck: tabelas, índice ou função ausentes';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'configuracao_agenda'
       AND column_name IN ('dias_semana', 'capacidade', 'desativado_a_partir_de', 'horario_livre')) <> 4 THEN
    RAISE EXCEPTION '093 postcheck: colunas de configuracao_agenda ausentes';
  END IF;
  IF EXISTS (SELECT 1 FROM configuracao_agenda WHERE dias_semana IS NOT NULL OR capacidade <> 1
              OR desativado_a_partir_de IS NOT NULL OR horario_livre) THEN
    RAISE EXCEPTION '093 postcheck: horário existente mudou de comportamento';
  END IF;
  RAISE NOTICE '093 postcheck OK';
END $$;
