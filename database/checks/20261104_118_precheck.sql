-- 118 precheck PREPARADO, NÃO EXECUTADO. Somente leitura. Exige empresas e 055c e a ausência de qualquer objeto da 118.
BEGIN TRANSACTION READ ONLY;
SET LOCAL search_path = public, pg_catalog;
DO $$ BEGIN
  IF to_regclass('public.empresas') IS NULL THEN RAISE EXCEPTION '118 precheck: empresas ausente'; END IF;
  IF to_regclass('public.ia_documentos') IS NULL THEN RAISE EXCEPTION '118 precheck: 055c ausente'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.ia_documentos'::regclass AND conname = 'ia_documentos_empresa_uk')
    THEN RAISE EXCEPTION '118 precheck: UNIQUE (id, empresa_id) de ia_documentos (055c) ausente'; END IF;
  IF to_regclass('public.ia_importacao_cotas') IS NOT NULL OR to_regclass('public.ia_importacao_usos') IS NOT NULL
     OR to_regprocedure('public.kidmais_118_janela_migracao(timestamptz,timestamptz)') IS NOT NULL
     OR to_regprocedure('public.kidmais_118_periodo_mensal(timestamptz)') IS NOT NULL
     OR to_regprocedure('public.kidmais_118_guarda()') IS NOT NULL
    THEN RAISE EXCEPTION '118 precheck: 118 já (parcialmente) presente'; END IF;
END $$;
SELECT current_database() AS banco, (SELECT count(*) FROM ia_documentos) AS documentos, true AS aprovado;
ROLLBACK;
