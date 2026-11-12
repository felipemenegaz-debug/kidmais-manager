-- Rollback da 096. Recusa se já existir versão arquivada ou comprovante: são prova da contratação e do texto aceito, e o
-- rollback os apagaria. Nesse caso, corrija para frente. ANTES do rollback, volte o código para a versão anterior.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;
DO $$
BEGIN
  -- Todos os objetos presentes; estado parcial é recusado com motivo explícito, antes de qualquer DROP.
  IF to_regclass('public.documentos_legais_versoes') IS NULL OR to_regclass('public.assinatura_comprovantes') IS NULL
     OR to_regclass('public.assinatura_comprovantes_empresa_idx') IS NULL OR to_regprocedure('public.kidmais_096_guarda()') IS NULL
     OR (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal
           AND tgname IN ('documentos_legais_versoes_096_guarda', 'assinatura_comprovantes_096_guarda')) <> 2 THEN
    RAISE EXCEPTION '096 rollback recusado: migration ausente ou parcial.';
  END IF;
END $$;
LOCK TABLE documentos_legais_versoes, assinatura_comprovantes IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM documentos_legais_versoes) OR EXISTS (SELECT 1 FROM assinatura_comprovantes) THEN
    RAISE EXCEPTION '096 rollback recusado: já há versão arquivada ou comprovante registrado. Preserve e corrija para frente.';
  END IF;
END $$;
DROP TABLE assinatura_comprovantes;
DROP TABLE documentos_legais_versoes;
DROP FUNCTION kidmais_096_guarda();
COMMIT;
