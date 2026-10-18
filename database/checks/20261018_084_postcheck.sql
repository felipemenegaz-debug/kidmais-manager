-- Somente leitura: colunas, constraints e índice da 084; nenhuma linha antiga recebeu etapa ou classe.
DO $$
DECLARE definicao text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='convite_geracoes' AND column_name='etapas_registradas' AND data_type='boolean' AND is_nullable='NO')
    OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='convite_geracoes' AND column_name='enviado_em' AND data_type='timestamp with time zone')
    OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='convite_geracoes' AND column_name='recebido_em' AND data_type='timestamp with time zone')
    OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='convite_geracoes' AND column_name='resultado_pendente' AND data_type='bytea')
    OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='convite_geracoes' AND column_name='falha_classe' AND data_type='text')
    OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='convite_geracoes' AND column_name='falha_diagnostico' AND data_type='text')
    OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='convite_geracoes' AND column_name='falha_detalhes' AND data_type='jsonb') THEN
    RAISE EXCEPTION '084 postcheck: colunas ausentes ou incompatíveis';
  END IF;
  SELECT pg_get_constraintdef(oid) INTO definicao FROM pg_constraint WHERE conrelid='public.convite_geracoes'::regclass AND conname='convite_geracoes_estado_check' AND contype='c' AND convalidated;
  IF definicao IS NULL OR definicao NOT LIKE '%NAO_ENVIADA%' OR definicao NOT LIKE '%RESOLVIDA_SEM_COBRANCA%'
    OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.convite_geracoes'::regclass AND conname='convite_geracoes_etapas_consistentes' AND contype='c' AND convalidated)
    OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.convite_geracoes'::regclass AND conname='convite_geracoes_resolucao_consistente' AND contype='c' AND convalidated)
    OR NOT EXISTS (SELECT 1 FROM pg_index WHERE indexrelid='public.convite_geracoes_em_aberto'::regclass AND indisvalid) THEN
    RAISE EXCEPTION '084 postcheck: constraints ou índice ausente';
  END IF;
  RAISE NOTICE '084 postcheck OK';
END $$;
SELECT estado, count(*) AS geracoes, count(*) FILTER (WHERE etapas_registradas) AS com_etapas, count(enviado_em) AS com_envio, count(falha_classe) AS com_classe FROM convite_geracoes GROUP BY estado ORDER BY estado;
