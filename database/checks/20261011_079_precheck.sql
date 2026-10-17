-- Somente leitura. Confirma schema de convites e que a 079 ainda não foi aplicada.
DO $$
DECLARE definicao text;
  item record;
BEGIN
  IF to_regclass('public.convite_geracoes') IS NULL
    OR to_regclass('public.convite_consumos') IS NULL
    OR to_regclass('public.convite_orcamento_global') IS NULL
    OR to_regclass('public.convites') IS NULL
    OR to_regclass('public.convite_eventos') IS NULL
    OR to_regclass('public.usuarios_administrativos') IS NULL THEN
    RAISE EXCEPTION '079 precheck: schema base de convites/identidade ausente';
  END IF;
  SELECT pg_get_constraintdef(oid) INTO definicao FROM pg_constraint
    WHERE conrelid='public.convite_geracoes'::regclass AND conname='convite_geracoes_estado_check';
  IF definicao IS NULL OR definicao NOT LIKE '%RESERVADA%' OR definicao NOT LIKE '%CONCLUIDA%' OR definicao NOT LIKE '%INCERTA%' THEN
    RAISE EXCEPTION '079 precheck: CHECK de estado não corresponde ao schema de convites';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='convite_geracoes'
      AND column_name IN ('resolucao_resultado','resolucao_por','resolucao_em','resolucao_evidencia','reserva_microusd'))
    OR to_regclass('public.convite_geracoes_incertas') IS NOT NULL
    OR EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.convite_geracoes'::regclass AND conname='convite_geracoes_resolucao_consistente') THEN
    RAISE EXCEPTION '079 precheck: aplicação anterior ou parcial encontrada';
  END IF;
  FOR item IN SELECT * FROM (VALUES
    ('convite_geracoes','id','uuid'),('convite_geracoes','convite_id','uuid'),('convite_geracoes','empresa_id','uuid'),
    ('convite_geracoes','ator','text'),('convite_geracoes','payload_hash','text'),('convite_geracoes','estado','text'),('convite_geracoes','criado_em','timestamp with time zone'),
    ('convites','usado_festa','integer'),('convites','usado_cliente','integer'),
    ('convite_consumos','empresa_id','uuid'),('convite_consumos','mes','date'),('convite_consumos','usado','integer'),
    ('convite_orcamento_global','dia','date'),('convite_orcamento_global','reservado_microusd','bigint'),
    ('convite_eventos','convite_id','uuid'),('convite_eventos','ator','text'),('convite_eventos','acao','text'),('convite_eventos','detalhe','jsonb'),
    ('usuarios_administrativos','id','uuid')
  ) AS colunas(tabela,coluna,tipo)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=item.tabela
        AND column_name=item.coluna AND data_type=item.tipo) THEN
      RAISE EXCEPTION '079 precheck: coluna base incompatível: %.%', item.tabela, item.coluna;
    END IF;
  END LOOP;
  RAISE NOTICE '079 precheck OK';
END $$;
