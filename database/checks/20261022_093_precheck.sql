-- Somente leitura. Confirma 043/062 e que a 093 ainda não foi aplicada.
DO $$
BEGIN
  IF to_regclass('public.configuracao_agenda') IS NULL OR to_regclass('public.estabelecimentos') IS NULL
    OR to_regclass('public.pacotes') IS NULL OR to_regclass('public.usuarios_administrativos') IS NULL
    OR to_regprocedure('public.kidmais062_unidade_agendavel(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION '093 precheck: configuracao_agenda, estabelecimentos, pacotes, usuarios_administrativos ou a 062 ausente';
  END IF;
  IF to_regclass('public.agenda_escopo_config') IS NOT NULL OR to_regclass('public.agenda_saloes') IS NOT NULL
    OR to_regclass('public.configuracao_agenda_saloes') IS NOT NULL OR to_regclass('public.pacote_saloes') IS NOT NULL
    OR to_regprocedure('public.kidmais093_mesma_empresa()') IS NOT NULL
    OR EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'configuracao_agenda'
                AND column_name IN ('dias_semana', 'capacidade', 'desativado_a_partir_de', 'horario_livre')) THEN
    RAISE EXCEPTION '093 precheck: aplicação anterior ou parcial encontrada';
  END IF;
  RAISE NOTICE '093 precheck OK';
END $$;
-- Contagem informativa (sem ids): horários por nível de escopo.
SELECT CASE WHEN estabelecimento_id IS NOT NULL THEN 'UNIDADE' WHEN empresa_id IS NOT NULL THEN 'EMPRESA' ELSE 'GLOBAL' END AS nivel,
       count(*) AS horarios
  FROM configuracao_agenda GROUP BY 1 ORDER BY 1;
