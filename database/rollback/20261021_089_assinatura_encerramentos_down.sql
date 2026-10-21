-- Rollback da 089. Recusa quando já existe algum pedido registrado: é a prova do pedido do cliente (protocolo, valor e
-- situação do estorno). Nesse caso, preserve e corrija para frente.
-- ANTES do rollback, volte o código para a versão anterior (o código da 089 só usa a tabela quando ela existe).
-- Empresas encerradas antecipadamente continuam ENCERRADAS: o rollback não reabre período nenhum.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;
DO $$
BEGIN
  IF to_regclass('public.assinatura_encerramentos') IS NULL THEN
    RAISE EXCEPTION '089 rollback recusado: migration ausente ou parcial.';
  END IF;
END $$;
LOCK TABLE assinatura_encerramentos IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM assinatura_encerramentos) THEN
    RAISE EXCEPTION '089 rollback recusado: há pedidos de encerramento registrados. Preserve a evidência e faça correção para frente.';
  END IF;
END $$;
DROP TABLE assinatura_encerramentos;
DROP FUNCTION kidmais_089_encerramento_guarda();
COMMIT;
