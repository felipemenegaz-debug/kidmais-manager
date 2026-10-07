-- 067 postcheck (somente leitura). Tabelas, gatilhos de guarda e nenhuma empresa existente com assinatura.
DO $$ BEGIN
  IF to_regclass('public.empresa_assinaturas') IS NULL OR to_regclass('public.empresa_excecoes_comerciais') IS NULL
     OR to_regclass('public.empresa_representacoes') IS NULL THEN
    RAISE EXCEPTION '067 postcheck: tabelas ausentes.';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('empresa_excecoes_067_guarda_trg', 'empresa_representacoes_067_guarda_trg')) <> 2 THEN
    RAISE EXCEPTION '067 postcheck: gatilhos de guarda ausentes.';
  END IF;
  RAISE NOTICE '067 postcheck OK: assinaturas = %, exceções = %, representações = %',
    (SELECT count(*) FROM empresa_assinaturas), (SELECT count(*) FROM empresa_excecoes_comerciais), (SELECT count(*) FROM empresa_representacoes);
END $$;
