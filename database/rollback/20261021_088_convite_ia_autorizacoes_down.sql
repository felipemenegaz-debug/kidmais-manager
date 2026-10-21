-- Rollback da 088. Recusa quando já existe alguma autorização registrada: é evidência do consentimento do
-- responsável (e da revogação). Nesse caso, preserve e corrija para frente.
-- ANTES do rollback, volte o código para a versão anterior: o código da 088 recusa toda geração sem a tabela.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;
DO $$
BEGIN
  IF to_regclass('public.convite_ia_autorizacoes') IS NULL THEN
    RAISE EXCEPTION '088 rollback recusado: migration ausente ou parcial.';
  END IF;
END $$;
LOCK TABLE convite_ia_autorizacoes IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM convite_ia_autorizacoes) THEN
    RAISE EXCEPTION '088 rollback recusado: há autorizações registradas. Preserve a evidência e faça correção para frente.';
  END IF;
END $$;
DROP TABLE convite_ia_autorizacoes;
DROP FUNCTION convite_ia_autorizacao_validar();
COMMIT;
