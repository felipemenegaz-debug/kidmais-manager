-- 072 rollback. Recusa com qualquer modelo publicado (contratos podem ter sido gerados nele).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = public, pg_catalog;

DO $$ BEGIN
  IF to_regclass('public.modelos_contrato_empresa') IS NULL THEN RAISE EXCEPTION '072 rollback: 072 não aplicada.'; END IF;
END $$;

LOCK TABLE modelos_contrato_empresa IN ACCESS EXCLUSIVE MODE;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM modelos_contrato_empresa) THEN
    RAISE EXCEPTION '072 rollback recusado: há modelos de contrato publicados.';
  END IF;
END $$;

DROP TABLE modelos_contrato_empresa;
DROP FUNCTION kidmais_072_guarda_modelo();

COMMIT;
