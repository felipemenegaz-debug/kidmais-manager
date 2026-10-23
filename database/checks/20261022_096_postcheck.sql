-- Somente leitura: tabelas, CHECK do hash (SHA-256 conferido pelo banco), FK do comprovante e gatilhos ROW BEFORE
-- INSERT/UPDATE/DELETE (tgtype = 31) com a guarda da 096.
DO $$
BEGIN
  IF to_regclass('public.documentos_legais_versoes') IS NULL OR to_regclass('public.assinatura_comprovantes') IS NULL
    OR to_regclass('public.assinatura_comprovantes_empresa_idx') IS NULL OR to_regprocedure('public.kidmais_096_guarda()') IS NULL THEN
    RAISE EXCEPTION '096 postcheck: objeto ausente';
  END IF;
  IF (SELECT count(*) FROM pg_constraint WHERE convalidated AND conname IN ('documentos_legais_versoes_conteudo_hash_check',
        'assinatura_comprovantes_contratacao_fk', 'assinatura_comprovantes_envio_check')) <> 3 THEN
    RAISE EXCEPTION '096 postcheck: restrição ausente';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled = 'O' AND tgtype = 31
        AND tgfoid = 'public.kidmais_096_guarda()'::regprocedure AND (
        (tgrelid = 'public.documentos_legais_versoes'::regclass AND tgname = 'documentos_legais_versoes_096_guarda')
        OR (tgrelid = 'public.assinatura_comprovantes'::regclass AND tgname = 'assinatura_comprovantes_096_guarda'))) <> 2 THEN
    RAISE EXCEPTION '096 postcheck: gatilhos ausentes ou divergentes';
  END IF;
  RAISE NOTICE '096 postcheck OK';
END $$;
SELECT (SELECT count(*) FROM documentos_legais_versoes) AS versoes_arquivadas, (SELECT count(*) FROM assinatura_comprovantes) AS comprovantes;
