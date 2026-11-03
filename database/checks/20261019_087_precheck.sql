-- PREPARADO, NÃO EXECUTADO. Somente leitura, sem dados de destinatários.
BEGIN TRANSACTION READ ONLY;
DO $$ BEGIN
  IF to_regclass('public.empresa_assinaturas') IS NULL OR to_regclass('public.memberships') IS NULL
     OR to_regclass('public.usuarios_administrativos') IS NULL OR to_regclass('public.empresas') IS NULL
    THEN RAISE EXCEPTION '087 exige a 068 instalada.'; END IF;
  IF to_regclass('public.assinatura_avisos') IS NOT NULL OR to_regprocedure('public.kidmais_087_aviso_guarda()') IS NOT NULL
    THEN RAISE EXCEPTION '087 já instalada total ou parcialmente.'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto') AND to_regprocedure('pg_catalog.gen_random_uuid()') IS NULL
    THEN RAISE EXCEPTION '087 exige gen_random_uuid().'; END IF;
  RAISE NOTICE '087 precheck OK';
END $$;
SELECT (SELECT count(*) FROM public.empresa_assinaturas)::int AS empresas_com_assinatura,
       to_regclass('public.assinatura_avisos') IS NULL AS avisos_ausentes;
ROLLBACK;
