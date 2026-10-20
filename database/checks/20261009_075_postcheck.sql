-- PREPARADO, NÃO EXECUTADO. Somente leitura, sem dados de destinatários.
BEGIN TRANSACTION READ ONLY;
DO $$ BEGIN
  IF to_regclass('public.assinatura_renovacoes') IS NULL THEN RAISE EXCEPTION '075 ausente.'; END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.assinatura_renovacoes'::regclass AND NOT tgisinternal
      AND tgenabled = 'O' AND tgname IN ('assinatura_renovacoes_075_guarda','assinatura_renovacoes_075_truncate')) <> 2
    THEN RAISE EXCEPTION '075: guardas ausentes.'; END IF;
  IF EXISTS (SELECT 1 FROM public.assinatura_renovacoes r JOIN public.assinatura_contratacoes c ON c.id = r.contratacao_id
      WHERE c.empresa_id <> r.empresa_id OR c.fundador_id IS NULL OR c.estado <> 'CONFIRMADA')
    THEN RAISE EXCEPTION '075: vínculo de renovação inválido.'; END IF;
END $$;
ROLLBACK;
