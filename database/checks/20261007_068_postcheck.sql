-- 068 postcheck (somente leitura). Tabela de eventos, colunas, índice único do teste e gatilhos de guarda.
DO $$ BEGIN
  IF to_regclass('public.cobranca_eventos') IS NULL THEN RAISE EXCEPTION '068 postcheck: cobranca_eventos ausente.'; END IF;
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'empresa_assinaturas'
        AND column_name IN ('documento_teste', 'provedor_situacao', 'sincronizado_em')) <> 3 THEN
    RAISE EXCEPTION '068 postcheck: colunas da assinatura ausentes.';
  END IF;
  IF to_regclass('public.empresa_assinaturas_documento_teste_uk') IS NULL THEN RAISE EXCEPTION '068 postcheck: índice do teste por CNPJ ausente.'; END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname IN (
        'empresa_assinaturas_068_guarda_trg', 'empresa_assinaturas_068_sem_truncate_trg', 'cobranca_eventos_068_guarda_trg', 'cobranca_eventos_068_sem_truncate_trg')) <> 4 THEN
    RAISE EXCEPTION '068 postcheck: gatilhos de guarda ausentes.';
  END IF;
  RAISE NOTICE '068 postcheck OK: assinaturas = %, eventos = %', (SELECT count(*) FROM empresa_assinaturas), (SELECT count(*) FROM cobranca_eventos);
END $$;
