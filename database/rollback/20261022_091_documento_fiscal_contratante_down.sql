-- Rollback da 091. Recusa se já existir algum CPF (teste, concessão, cadastro ou pedido) ou representação TITULAR_PF: o
-- código antigo não sabe tratar pessoa física e o rollback apagaria a prova do contratante. Nesse caso, desligue
-- ASSINATURA_CPF_ATIVO e corrija para frente. ANTES do rollback, volte o código para a versão anterior.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;
DO $$
BEGIN
  -- Todos os objetos da 091 presentes; estado parcial é recusado com motivo explícito, antes de qualquer DROP.
  IF to_regprocedure('public.kidmais_091_documento_valido(text)') IS NULL OR to_regprocedure('public.kidmais_091_documento_guarda()') IS NULL
     OR (SELECT count(*) FROM pg_trigger WHERE tgname IN ('empresa_assinaturas_091_documento','assinatura_fundadores_091_documento')) <> 2 THEN
    RAISE EXCEPTION '091 rollback recusado: migration ausente ou parcial.';
  END IF;
END $$;
LOCK TABLE empresa_assinaturas, assinatura_fundadores, cadastros_empresas, solicitacoes_acesso_empresa, empresa_representacoes IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM empresa_assinaturas WHERE documento_teste ~ '^[0-9]{11}$')
    OR EXISTS (SELECT 1 FROM assinatura_fundadores WHERE documento_beneficiario ~ '^[0-9]{11}$')
    OR EXISTS (SELECT 1 FROM cadastros_empresas WHERE documento ~ '^[0-9]{11}$')
    OR EXISTS (SELECT 1 FROM solicitacoes_acesso_empresa WHERE documento ~ '^[0-9]{11}$')
    OR EXISTS (SELECT 1 FROM empresa_representacoes WHERE qualificacao = 'TITULAR_PF') THEN
    RAISE EXCEPTION '091 rollback recusado: já há contratante pessoa física registrado. Preserve e corrija para frente.';
  END IF;
END $$;
DROP TRIGGER empresa_assinaturas_091_documento ON empresa_assinaturas;
DROP TRIGGER assinatura_fundadores_091_documento ON assinatura_fundadores;
DROP FUNCTION kidmais_091_documento_guarda();
ALTER TABLE empresa_assinaturas
  DROP CONSTRAINT empresa_assinaturas_documento_teste_check,
  ADD CONSTRAINT empresa_assinaturas_documento_teste_check CHECK (documento_teste IS NULL OR documento_teste ~ '^[0-9A-Z]{12}[0-9]{2}$');
ALTER TABLE assinatura_fundadores
  DROP CONSTRAINT assinatura_fundadores_documento_beneficiario_check,
  ADD CONSTRAINT assinatura_fundadores_documento_beneficiario_check CHECK (documento_beneficiario ~ '^[0-9A-Z]{12}[0-9]{2}$');
ALTER TABLE cadastros_empresas
  DROP CONSTRAINT cadastros_empresas_documento_check,
  ADD CONSTRAINT cadastros_empresas_documento_check CHECK (documento ~ '^[0-9A-Z]{12}[0-9]{2}$');
ALTER TABLE solicitacoes_acesso_empresa
  DROP CONSTRAINT solicitacoes_documento_check,
  ADD CONSTRAINT solicitacoes_documento_check CHECK (documento ~ '^[0-9A-Z]{12}[0-9]{2}$');
ALTER TABLE empresa_representacoes
  DROP CONSTRAINT empresa_representacoes_qualificacao_check,
  ADD CONSTRAINT empresa_representacoes_qualificacao_check CHECK (qualificacao IN ('SOCIO_ADMINISTRADOR','PROCURADOR','RESPONSAVEL_INDICADO'));
DROP FUNCTION kidmais_091_documento_valido(text);
COMMIT;
