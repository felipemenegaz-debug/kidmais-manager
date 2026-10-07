-- 069 postcheck (somente leitura). Tabelas, índices únicos e gatilhos de guarda.
DO $$ BEGIN
  IF to_regclass('public.cadastros_publicos') IS NULL OR to_regclass('public.aceites_documentos_legais') IS NULL
     OR to_regclass('public.cadastros_empresas') IS NULL OR to_regclass('public.empresa_socios') IS NULL
     OR to_regclass('public.solicitacoes_acesso_empresa') IS NULL THEN
    RAISE EXCEPTION '069 postcheck: tabelas ausentes.';
  END IF;
  IF to_regclass('public.cadastros_publicos_pendente_uk') IS NULL OR to_regclass('public.solicitacoes_pendente_uk') IS NULL THEN
    RAISE EXCEPTION '069 postcheck: índices únicos ausentes.';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('cadastros_publicos_069_guarda_trg', 'aceites_069_somente_insercao_trg',
        'cadastros_empresas_069_somente_insercao_trg', 'empresa_socios_069_somente_insercao_trg')) <> 4 THEN
    RAISE EXCEPTION '069 postcheck: gatilhos de guarda ausentes.';
  END IF;
  RAISE NOTICE '069 postcheck OK: pedidos = %, aceites = %', (SELECT count(*) FROM cadastros_publicos), (SELECT count(*) FROM aceites_documentos_legais);
END $$;
