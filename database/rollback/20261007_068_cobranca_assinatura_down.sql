-- 068 rollback. Recusa se houver evento de cobrança, assinatura registrada ou dado preenchido pelas colunas da 068
-- (não apaga dado comercial). Depois dele a 067 volta exatamente ao estado de antes.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = public, pg_catalog;

DO $$ BEGIN
  IF to_regclass('public.cobranca_eventos') IS NULL THEN RAISE EXCEPTION '068 rollback: 068 não aplicada.'; END IF;
END $$;

LOCK TABLE empresa_assinaturas, cobranca_eventos IN ACCESS EXCLUSIVE MODE;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM cobranca_eventos) OR EXISTS (SELECT 1 FROM empresa_assinaturas) THEN
    RAISE EXCEPTION '068 rollback recusado: há eventos de cobrança ou assinaturas registradas.';
  END IF;
END $$;

DROP TABLE cobranca_eventos;
DROP FUNCTION kidmais_068_evento_guarda();
DROP TRIGGER empresa_assinaturas_068_sem_truncate_trg ON empresa_assinaturas;
DROP TRIGGER empresa_assinaturas_068_guarda_trg ON empresa_assinaturas;
DROP FUNCTION kidmais_068_sem_truncate();
DROP FUNCTION kidmais_068_assinatura_guarda();
DROP INDEX empresa_assinaturas_documento_teste_uk;
ALTER TABLE empresa_assinaturas
  DROP CONSTRAINT empresa_assinaturas_teste_teto_check,
  DROP CONSTRAINT empresa_assinaturas_provedor_situacao_check,
  DROP CONSTRAINT empresa_assinaturas_documento_teste_check,
  DROP COLUMN sincronizado_em,
  DROP COLUMN provedor_situacao,
  DROP COLUMN documento_teste;

COMMIT;
