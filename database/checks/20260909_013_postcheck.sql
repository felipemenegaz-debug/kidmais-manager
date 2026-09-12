DO $$
DECLARE nome text;
BEGIN
 FOREACH nome IN ARRAY ARRAY['usuarios_administrativos','sessoes_administrativas','limites_autenticacao','contrato_fluxos','contrato_edicoes','contrato_documentos','contrato_assinaturas','contrato_pendencias_financeiras'] LOOP
  IF to_regclass('public.'||nome) IS NULL THEN RAISE EXCEPTION '013: tabela ausente %',nome; END IF;
 END LOOP;
 IF to_regclass('public.contrato_versoes_corrente_uk') IS NOT NULL OR to_regclass('public.contrato_versoes_em_preparacao_uk') IS NULL THEN RAISE EXCEPTION '013: índice de preparação divergente'; END IF;
 IF EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.contrato_assinaturas'::regclass AND confrelid='public.sessoes_administrativas'::regclass) THEN RAISE EXCEPTION '013: assinatura não pode ter FK de sessão'; END IF;
 IF NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='contrato_documentos' AND column_name='conteudo_pdf' AND data_type='bytea' AND is_nullable='NO') THEN RAISE EXCEPTION '013: BYTEA ausente'; END IF;
 IF EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='contrato_documentos' AND column_name IN ('storage_provider','storage_chave')) THEN RAISE EXCEPTION '013: filesystem não autorizado'; END IF;
END $$;
SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND tablename IN ('usuarios_administrativos','sessoes_administrativas','contrato_documentos','contrato_assinaturas') ORDER BY 1,2;
