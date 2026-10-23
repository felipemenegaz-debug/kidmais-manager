-- Somente leitura: tabelas, CHECK do hash (SHA-256 conferido pelo banco), FK do comprovante e gatilhos ROW BEFORE
-- INSERT/UPDATE/DELETE (tgtype = 31) com a guarda da 096.
DO $$
BEGIN
  IF to_regclass('public.documentos_legais_versoes') IS NULL OR to_regclass('public.assinatura_comprovantes') IS NULL
    OR to_regclass('public.assinatura_comprovantes_empresa_idx') IS NULL OR to_regprocedure('public.kidmais_096_guarda()') IS NULL THEN
    RAISE EXCEPTION '096 postcheck: objeto ausente';
  END IF;
  -- Não basta o nome: relação, tipo e definição de cada garantia anunciada (revisão 00cecac, P3-B1).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE convalidated AND contype = 'c' AND conname = 'documentos_legais_versoes_conteudo_hash_check'
        AND conrelid = 'public.documentos_legais_versoes'::regclass
        AND pg_get_constraintdef(oid) LIKE '%encode(sha256(convert_to(conteudo, ''UTF8''::name)), ''hex''::text) = hash%')
    OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE convalidated AND contype = 'f' AND conname = 'assinatura_comprovantes_contratacao_fk'
        AND conrelid = 'public.assinatura_comprovantes'::regclass AND confrelid = 'public.assinatura_contratacoes'::regclass
        AND pg_get_constraintdef(oid) = 'FOREIGN KEY (empresa_id, contratacao_id) REFERENCES assinatura_contratacoes(empresa_id, id)')
    OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE convalidated AND contype = 'c' AND conname = 'assinatura_comprovantes_envio_check'
        AND conrelid = 'public.assinatura_comprovantes'::regclass
        AND pg_get_constraintdef(oid) = 'CHECK (((email_enviado_em IS NULL) OR (email_falhou_em IS NULL)))')
    OR NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.assinatura_comprovantes'::regclass AND attname = 'prestadora' AND attnotnull AND NOT attisdropped) THEN
    RAISE EXCEPTION '096 postcheck: restrição ausente ou com definição divergente';
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
