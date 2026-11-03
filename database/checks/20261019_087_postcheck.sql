-- PREPARADO, NÃO EXECUTADO. Somente leitura, sem dados de destinatários nem mensagens.
BEGIN TRANSACTION READ ONLY;
DO $$ BEGIN
  IF to_regclass('public.assinatura_avisos') IS NULL THEN RAISE EXCEPTION '087 ausente.'; END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.assinatura_avisos'::regclass AND NOT tgisinternal
      AND tgenabled = 'O' AND tgname IN ('assinatura_avisos_087_guarda','assinatura_avisos_087_truncate')) <> 2
    THEN RAISE EXCEPTION '087: guardas ausentes.'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.assinatura_avisos'::regclass
      AND conname = 'assinatura_avisos_087_um_por_evento' AND contype = 'u')
    THEN RAISE EXCEPTION '087: unicidade por evento ausente.'; END IF;
  IF EXISTS (SELECT 1 FROM public.assinatura_avisos v LEFT JOIN public.empresa_assinaturas a ON a.empresa_id = v.empresa_id
      WHERE a.empresa_id IS NULL)
    THEN RAISE EXCEPTION '087: aviso de empresa sem assinatura.'; END IF;
  RAISE NOTICE '087 postcheck OK';
END $$;
SELECT estado, count(*)::int AS avisos FROM public.assinatura_avisos GROUP BY estado ORDER BY estado;
ROLLBACK;
