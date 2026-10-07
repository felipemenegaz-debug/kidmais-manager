-- 066 rollback. Recusa se alguma empresa já configurou a chave Pix (não apaga configuração em uso).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = public, pg_catalog;

DO $$ BEGIN
  IF to_regclass('public.empresa_pix_recebimento') IS NULL THEN RAISE EXCEPTION '066 rollback: tabela ausente (066 não aplicada).'; END IF;
END $$;

LOCK TABLE empresa_pix_recebimento IN ACCESS EXCLUSIVE MODE;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM empresa_pix_recebimento) THEN
    RAISE EXCEPTION '066 rollback recusado: há chave Pix configurada. Remova pela tela (auditado) antes de reverter.';
  END IF;
END $$;

DROP TABLE empresa_pix_recebimento;

COMMIT;
