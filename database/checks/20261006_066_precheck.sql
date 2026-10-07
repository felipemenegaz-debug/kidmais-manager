-- 066 precheck (somente leitura). Pré-requisitos: empresas (031) e usuarios_administrativos (013); 066 ausente.
DO $$ BEGIN
  IF to_regclass('public.empresa_pix_recebimento') IS NOT NULL THEN RAISE EXCEPTION '066 precheck: já aplicada.'; END IF;
  IF to_regclass('public.empresas') IS NULL THEN RAISE EXCEPTION '066 precheck: 031 não aplicada (empresas).'; END IF;
  IF to_regclass('public.usuarios_administrativos') IS NULL THEN RAISE EXCEPTION '066 precheck: 013 não aplicada.'; END IF;
  RAISE NOTICE '066 precheck OK: empresas = %', (SELECT count(*) FROM empresas);
END $$;
