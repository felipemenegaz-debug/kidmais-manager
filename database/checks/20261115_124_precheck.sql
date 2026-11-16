-- 124 precheck PREPARADO, NÃO EXECUTADO. Somente leitura. Mesmas condições do bloco inicial da migration, mais a
-- recusa de instalação parcial (qualquer objeto da 124 já presente).
BEGIN TRANSACTION READ ONLY;
SET LOCAL search_path = public, pg_catalog;
DO $$ BEGIN
  IF to_regclass('public.contrato_assinaturas_papel') IS NOT NULL
     OR to_regprocedure('public.kidmais124_papel_cliente(uuid,uuid)') IS NOT NULL
     OR to_regprocedure('public.kidmais124_validar_registro_papel()') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname LIKE 'kidmais124\_%')
     OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgname LIKE 'contrato_assinaturas_papel\_%')
     OR EXISTS (SELECT 1 FROM public.contrato_versoes WHERE aceite_metodo NOT IN ('OTP', 'CONFERENCIA_PAPEL')) THEN
    RAISE EXCEPTION '124 precheck: 124 já aplicada ou parcialmente presente';
  END IF;
  IF to_regclass('public.contrato_importacoes') IS NULL THEN RAISE EXCEPTION '124 precheck: exige a 061'; END IF;
  IF to_regclass('public.oportunidades_acoes') IS NULL THEN RAISE EXCEPTION '124 precheck: exige a 122'; END IF;
  IF to_regclass('public.festa_pessoas') IS NULL THEN RAISE EXCEPTION '124 precheck: exige a 123'; END IF;
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.kidmais_validar_fluxo_contrato()')) IS DISTINCT FROM '0706e34186753e34bfcb6491e947492b' THEN
    RAISE EXCEPTION '124 precheck: validação de contrato diverge da 061';
  END IF;
  IF (SELECT encode(sha256(convert_to(replace(prosrc, E'\r', ''), 'UTF8')), 'hex') FROM pg_proc WHERE oid = to_regprocedure('public.kidmais019_formalizacao(uuid,uuid)')) IS DISTINCT FROM '1b428128346f7158389c6a3495f72e9c92a39930b2cb4afe571b9aec900a91ba' THEN
    RAISE EXCEPTION '124 precheck: formalização diverge da 061';
  END IF;
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.contrato_versoes'::regclass AND conname = 'contrato_versoes_aceite_metodo_check' AND convalidated)
     IS DISTINCT FROM 'CHECK (((aceite_metodo IS NULL) OR ((aceite_metodo)::text = ANY ((ARRAY[''OTP''::character varying, ''CONFERENCIA_PAPEL''::character varying])::text[]))))' THEN
    RAISE EXCEPTION '124 precheck: CHECK de método de aceite diverge da 061';
  END IF;
END $$;
SELECT current_database() AS banco, true AS aprovado;
ROLLBACK;
