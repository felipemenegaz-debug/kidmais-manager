-- 116 precheck PREPARADO, NÃO EXECUTADO. Somente leitura. Exige 074a e 095 e a ausência de qualquer objeto da 116.
BEGIN TRANSACTION READ ONLY;
SET LOCAL search_path = public, pg_catalog;
DO $$ BEGIN
  IF to_regclass('public.assinatura_contratacoes') IS NULL THEN RAISE EXCEPTION '116 precheck: 074a ausente'; END IF;
  IF to_regclass('public.ia_credito_lotes') IS NULL OR to_regprocedure('public.kidmais_095_guarda()') IS NULL
    THEN RAISE EXCEPTION '116 precheck: 095 ausente'; END IF;
  IF to_regclass('public.ia_credito_franquias_ciclo') IS NOT NULL OR to_regclass('public.ia_credito_franquia_pendencias') IS NOT NULL
     OR to_regprocedure('public.kidmais_116_somente_insercao()') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.ia_credito_notificacoes'::regclass
          AND conname = 'ia_credito_notificacoes_tipo_check' AND pg_get_constraintdef(oid) LIKE '%FRANQUIA_80%')
    THEN RAISE EXCEPTION '116 precheck: 116 já (parcialmente) presente'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.ia_credito_notificacoes'::regclass AND conname = 'ia_credito_notificacoes_tipo_check')
    THEN RAISE EXCEPTION '116 precheck: CHECK de tipo das notificações (095) ausente'; END IF;
END $$;
SELECT current_database() AS banco, (SELECT count(*) FROM ia_credito_lotes WHERE origem = 'FRANQUIA') AS lotes_franquia, true AS aprovado;
ROLLBACK;
