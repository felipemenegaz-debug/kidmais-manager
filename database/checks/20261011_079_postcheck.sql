-- Somente leitura: colunas, constraints e índice usados pela decisão manual.
DO $$
DECLARE definicao text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='convite_geracoes' AND column_name='resolucao_resultado' AND data_type='text')
    OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='convite_geracoes' AND column_name='resolucao_por' AND udt_name='uuid')
    OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='convite_geracoes' AND column_name='resolucao_em' AND data_type='timestamp with time zone')
    OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='convite_geracoes' AND column_name='resolucao_evidencia' AND data_type='text')
    OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='convite_geracoes' AND column_name='reserva_microusd' AND data_type='bigint') THEN
    RAISE EXCEPTION '079 postcheck: colunas ausentes ou incompatíveis';
  END IF;
  SELECT pg_get_constraintdef(oid) INTO definicao FROM pg_constraint WHERE conrelid='public.convite_geracoes'::regclass AND conname='convite_geracoes_resolucao_consistente' AND contype='c' AND convalidated;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.convite_geracoes'::regclass AND conname='convite_geracoes_estado_check' AND contype='c' AND convalidated)
    OR definicao IS NULL OR definicao NOT LIKE '%resolucao_resultado IS NOT NULL%' OR definicao NOT LIKE '%resolucao_evidencia IS NOT NULL%'
    OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.convite_geracoes'::regclass AND conkey @> ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='public.convite_geracoes'::regclass AND attname='resolucao_por')]::smallint[] AND contype='f' AND convalidated)
    OR NOT EXISTS (SELECT 1 FROM pg_index WHERE indexrelid='public.convite_geracoes_incertas'::regclass AND indisvalid) THEN
    RAISE EXCEPTION '079 postcheck: constraints, FK ou índice ausente';
  END IF;
  RAISE NOTICE '079 postcheck OK';
END $$;
