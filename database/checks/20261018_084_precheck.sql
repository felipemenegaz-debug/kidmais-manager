-- Somente leitura. Confirma a 079 aplicada e que a 084 ainda não foi aplicada.
DO $$
DECLARE definicao text;
BEGIN
  IF to_regclass('public.convite_geracoes') IS NULL OR to_regclass('public.convite_geracoes_incertas') IS NULL THEN
    RAISE EXCEPTION '084 precheck: convite_geracoes ou índice da 079 ausente';
  END IF;
  SELECT pg_get_constraintdef(oid) INTO definicao FROM pg_constraint
    WHERE conrelid='public.convite_geracoes'::regclass AND conname='convite_geracoes_estado_check';
  IF definicao IS NULL OR definicao NOT LIKE '%RESOLVIDA_COBRADA%' OR definicao NOT LIKE '%RESOLVIDA_SEM_COBRANCA%' THEN
    RAISE EXCEPTION '084 precheck: a 079 não está aplicada';
  END IF;
  IF definicao LIKE '%NAO_ENVIADA%'
    OR EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='convite_geracoes'
      AND column_name IN ('etapas_registradas','enviado_em','recebido_em','resultado_pendente','falha_classe','falha_diagnostico','falha_detalhes'))
    OR EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.convite_geracoes'::regclass AND conname='convite_geracoes_etapas_consistentes')
    OR to_regclass('public.convite_geracoes_em_aberto') IS NOT NULL THEN
    RAISE EXCEPTION '084 precheck: aplicação anterior ou parcial encontrada';
  END IF;
  RAISE NOTICE '084 precheck OK';
END $$;
-- Contagem informativa por estado (sem ids nem dados pessoais) para comparar com o postcheck. RESERVADA existentes
-- (código anterior) nunca são devolvidas automaticamente pela 084: depois de 10 min vão para a fila do operador.
SELECT estado, count(*) AS geracoes FROM convite_geracoes GROUP BY estado ORDER BY estado;
