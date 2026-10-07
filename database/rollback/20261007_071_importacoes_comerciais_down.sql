-- 071 rollback. Recusa com qualquer importação registrada (não apaga PDF nem revisão).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = public, pg_catalog;

DO $$ BEGIN
  IF to_regclass('public.importacoes_comerciais') IS NULL THEN RAISE EXCEPTION '071 rollback: 071 não aplicada.'; END IF;
END $$;

LOCK TABLE importacoes_comerciais IN ACCESS EXCLUSIVE MODE;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM importacoes_comerciais) THEN
    RAISE EXCEPTION '071 rollback recusado: há importações registradas.';
  END IF;
END $$;

DROP TABLE importacoes_comerciais;
DROP FUNCTION kidmais_071_guarda_importacao();

COMMIT;
