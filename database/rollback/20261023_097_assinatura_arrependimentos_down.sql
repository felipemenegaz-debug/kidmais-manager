-- Rollback da 097. Recusa se houver manifestação registrada (prova do exercício de um direito: nunca apagar). Nesse
-- caso, corrija para frente. ANTES do rollback, volte o código para a versão anterior.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;
DO $$
BEGIN
  IF to_regclass('public.assinatura_arrependimentos') IS NULL OR to_regprocedure('public.kidmais_097_guarda()') IS NULL
     OR to_regclass('public.assinatura_arrependimentos_pendentes_idx') IS NULL OR to_regclass('public.assinatura_arrependimentos_empresa_idx') IS NULL
     OR (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname = 'assinatura_arrependimentos_097_guarda') <> 1 THEN
    RAISE EXCEPTION '097 rollback recusado: migration ausente ou parcial.';
  END IF;
END $$;
LOCK TABLE assinatura_arrependimentos IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM assinatura_arrependimentos) THEN
    RAISE EXCEPTION '097 rollback recusado: já há manifestação de arrependimento registrada. Preserve e corrija para frente.';
  END IF;
END $$;
DROP TABLE assinatura_arrependimentos;
DROP FUNCTION kidmais_097_guarda();
COMMIT;
