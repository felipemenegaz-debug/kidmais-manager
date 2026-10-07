-- 067 precheck (somente leitura). Pré-requisitos: empresas (031), usuarios_administrativos (013), gen_random_uuid; 067 ausente.
DO $$ BEGIN
  IF to_regclass('public.empresa_assinaturas') IS NOT NULL OR to_regclass('public.empresa_excecoes_comerciais') IS NOT NULL
     OR to_regclass('public.empresa_representacoes') IS NOT NULL THEN
    RAISE EXCEPTION '067 precheck: já aplicada (total ou parcial).';
  END IF;
  IF to_regclass('public.empresas') IS NULL OR to_regclass('public.usuarios_administrativos') IS NULL THEN RAISE EXCEPTION '067 precheck: 013/031 ausentes.'; END IF;
  IF to_regprocedure('gen_random_uuid()') IS NULL THEN RAISE EXCEPTION '067 precheck: gen_random_uuid ausente.'; END IF;
  RAISE NOTICE '067 precheck OK: empresas = %', (SELECT count(*) FROM empresas);
END $$;
