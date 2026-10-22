-- Somente leitura: função de DV correta (casos sintéticos conhecidos), CHECKs alargados e DV para linhas novas.
DO $$
BEGIN
  IF to_regprocedure('public.kidmais_091_documento_valido(text)') IS NULL
    OR (SELECT provolatile FROM pg_proc WHERE oid = 'public.kidmais_091_documento_valido(text)'::regprocedure) <> 'i' THEN
    RAISE EXCEPTION '091 postcheck: função de DV ausente ou não imutável';
  END IF;
  -- CPF e CNPJ sintéticos com DV conhecido (não são documentos de pessoas): válidos, DV trocado, repetido, alfanumérico.
  IF NOT (kidmais_091_documento_valido('52998224725') AND kidmais_091_documento_valido('00000000191')
      AND NOT kidmais_091_documento_valido('52998224724') AND NOT kidmais_091_documento_valido('11111111111')
      AND kidmais_091_documento_valido('00000000000191') AND NOT kidmais_091_documento_valido('00000000000192')
      AND kidmais_091_documento_valido('12ABC34501DE35') AND NOT kidmais_091_documento_valido('12ABC34501DE34')
      AND NOT kidmais_091_documento_valido('5299822472') AND NOT kidmais_091_documento_valido('529.982.247-25')) THEN
    RAISE EXCEPTION '091 postcheck: função de DV divergente dos casos de referência';
  END IF;
  IF (SELECT count(*) FROM pg_constraint WHERE contype = 'c' AND convalidated AND conname IN ('empresa_assinaturas_documento_teste_check',
        'assinatura_fundadores_documento_beneficiario_check','cadastros_empresas_documento_check','solicitacoes_documento_check',
        'empresa_representacoes_qualificacao_check')) <> 5
    OR (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled = 'O' AND (
          (tgrelid = 'public.empresa_assinaturas'::regclass AND tgname = 'empresa_assinaturas_091_documento')
          OR (tgrelid = 'public.assinatura_fundadores'::regclass AND tgname = 'assinatura_fundadores_091_documento'))) <> 2
    OR to_regprocedure('public.kidmais_091_documento_guarda()') IS NULL
    -- O DV não é CHECK (valeria em todo UPDATE de linha antiga).
    OR EXISTS (SELECT 1 FROM pg_constraint WHERE contype = 'c' AND pg_get_constraintdef(oid) LIKE '%kidmais_091_documento_valido%') THEN
    RAISE EXCEPTION '091 postcheck: CHECKs ausentes';
  END IF;
  IF pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conname = 'empresa_assinaturas_documento_teste_check')) NOT LIKE '%[0-9]{11}|%'
    OR pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conname = 'empresa_representacoes_qualificacao_check')) NOT LIKE '%TITULAR_PF%' THEN
    RAISE EXCEPTION '091 postcheck: CHECK de formato ou qualificação não alargado';
  END IF;
  IF to_regclass('public.empresa_assinaturas_documento_teste_uk') IS NULL OR to_regclass('public.assinatura_fundadores_documento_uk') IS NULL THEN
    RAISE EXCEPTION '091 postcheck: unicidade de documento ausente';
  END IF;
  RAISE NOTICE '091 postcheck OK';
END $$;
-- Contagem informativa (sem documentos): contratantes por tipo de documento.
SELECT CASE WHEN length(documento_teste) = 11 THEN 'CPF' ELSE 'CNPJ' END AS tipo, count(*) AS assinaturas
  FROM empresa_assinaturas WHERE documento_teste IS NOT NULL GROUP BY 1 ORDER BY 1;
