-- Somente leitura. Confirma 062/093 e que a 094 ainda não foi aplicada.
DO $$
BEGIN
  IF to_regclass('public.agenda_escopo_config') IS NULL OR to_regclass('public.agenda_saloes') IS NULL
    OR to_regprocedure('public.kidmais062_ocupacoes_escopo(date,date)') IS NULL
    OR to_regprocedure('public.kidmais019_validar_destino(uuid)') IS NULL THEN
    RAISE EXCEPTION '094 precheck: 062 ou 093 ausente';
  END IF;
  IF to_regprocedure('public.kidmais094_conflito_ocupacao(uuid,date,time without time zone,time without time zone,uuid,uuid,uuid,uuid)') IS NOT NULL
    OR to_regprocedure('public.kidmais094_ocupacoes(date,date)') IS NOT NULL
    OR EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('fechamentos', 'fechamento_revisoes') AND column_name = 'salao_id') THEN
    RAISE EXCEPTION '094 precheck: aplicação anterior ou parcial encontrada';
  END IF;
  RAISE NOTICE '094 precheck OK';
END $$;
-- Contagem informativa (sem ids): escopos configurados na 093, por tipo de capacidade.
SELECT capacidade_tipo, count(*) AS escopos FROM agenda_escopo_config GROUP BY capacidade_tipo ORDER BY capacidade_tipo;
