-- 069 precheck (somente leitura). Exige 063, 067 e 068; 069 ausente.
DO $$ BEGIN
  IF to_regclass('public.plataforma_empresas_cadastro') IS NULL OR to_regclass('public.empresa_representacoes') IS NULL OR to_regclass('public.cobranca_eventos') IS NULL THEN
    RAISE EXCEPTION '069 precheck: 063, 067 ou 068 ausentes.';
  END IF;
  IF to_regclass('public.cadastros_publicos') IS NOT NULL OR to_regclass('public.aceites_documentos_legais') IS NOT NULL
     OR to_regclass('public.cadastros_empresas') IS NOT NULL OR to_regclass('public.empresa_socios') IS NOT NULL
     OR to_regclass('public.solicitacoes_acesso_empresa') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_proc WHERE proname IN ('kidmais_069_somente_insercao', 'kidmais_069_cadastro_guarda')) THEN
    RAISE EXCEPTION '069 precheck: já aplicada (total ou parcial).';
  END IF;
  RAISE NOTICE '069 precheck OK: usuários = %, empresas = %', (SELECT count(*) FROM usuarios_administrativos), (SELECT count(*) FROM empresas);
END $$;
