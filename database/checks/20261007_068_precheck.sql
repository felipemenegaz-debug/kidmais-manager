-- 068 precheck (somente leitura). Exige a 067 instalada, sem assinaturas, e a 068 ausente.
DO $$ BEGIN
  IF to_regclass('public.empresa_assinaturas') IS NULL OR to_regclass('public.empresa_excecoes_comerciais') IS NULL THEN
    RAISE EXCEPTION '068 precheck: 067 ausente.';
  END IF;
  IF to_regclass('public.cobranca_eventos') IS NOT NULL
     OR EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'empresa_assinaturas' AND column_name IN ('documento_teste', 'provedor_situacao', 'sincronizado_em'))
     OR EXISTS (SELECT 1 FROM pg_proc WHERE proname IN ('kidmais_068_assinatura_guarda', 'kidmais_068_evento_guarda', 'kidmais_068_sem_truncate')) THEN
    RAISE EXCEPTION '068 precheck: já aplicada (total ou parcial).';
  END IF;
  IF EXISTS (SELECT 1 FROM empresa_assinaturas) THEN RAISE EXCEPTION '068 precheck: a 067 já tem assinaturas.'; END IF;
  RAISE NOTICE '068 precheck OK: empresas = %, exceções = %', (SELECT count(*) FROM empresas), (SELECT count(*) FROM empresa_excecoes_comerciais);
END $$;
