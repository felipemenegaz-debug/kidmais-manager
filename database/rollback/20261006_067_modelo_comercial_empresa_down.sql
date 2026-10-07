-- 067 rollback. Recusa se houver qualquer assinatura, exceção ou representação registrada (não apaga dado comercial).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = public, pg_catalog;

DO $$ BEGIN
  IF to_regclass('public.empresa_assinaturas') IS NULL THEN RAISE EXCEPTION '067 rollback: 067 não aplicada.'; END IF;
END $$;

LOCK TABLE empresa_assinaturas, empresa_excecoes_comerciais, empresa_representacoes IN ACCESS EXCLUSIVE MODE;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM empresa_assinaturas) OR EXISTS (SELECT 1 FROM empresa_excecoes_comerciais) OR EXISTS (SELECT 1 FROM empresa_representacoes) THEN
    RAISE EXCEPTION '067 rollback recusado: há dados comerciais registrados.';
  END IF;
END $$;

DROP TABLE empresa_representacoes;
DROP TABLE empresa_excecoes_comerciais;
DROP TABLE empresa_assinaturas;
DROP FUNCTION kidmais_067_representacao_guarda();
DROP FUNCTION kidmais_067_excecao_guarda();

COMMIT;
