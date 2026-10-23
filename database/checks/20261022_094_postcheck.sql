-- Somente leitura. Confirma a 094: coluna do salão, funções novas e as três funções de conflito chamando a regra nova.
DO $$
BEGIN
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('fechamentos', 'fechamento_revisoes') AND column_name = 'salao_id') <> 2
    OR to_regprocedure('public.kidmais094_salao_revisao()') IS NULL
    OR to_regprocedure('public.kidmais094_conflito_ocupacao(uuid,date,time without time zone,time without time zone,uuid,uuid,uuid,uuid)') IS NULL
    OR to_regprocedure('public.kidmais094_ocupacoes(date,date)') IS NULL
    OR to_regprocedure('public.kidmais094_salao_fechamento()') IS NULL THEN
    RAISE EXCEPTION '094 postcheck: coluna ou funções ausentes';
  END IF;
  IF (SELECT count(*) FROM pg_proc WHERE proname IN ('kidmais019_validar_destino', 'kidmais019_validar_contrato', 'kidmais_validar_agenda_revisao')
       AND prosrc LIKE '%kidmais094_conflito_ocupacao%') <> 3 THEN
    RAISE EXCEPTION '094 postcheck: funções de conflito sem a regra nova';
  END IF;
  IF EXISTS (SELECT 1 FROM fechamentos WHERE salao_id IS NOT NULL) OR EXISTS (SELECT 1 FROM fechamento_revisoes WHERE salao_id IS NOT NULL) THEN
    RAISE EXCEPTION '094 postcheck: festa com salão logo após a aplicação';
  END IF;
  RAISE NOTICE '094 postcheck OK';
END $$;
