BEGIN;

DO $$ BEGIN
  IF to_regclass('public.fechamento_pacote_itens_especificos') IS NULL THEN
    RETURN;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('kidmais-051-down'));
  LOCK TABLE public.fechamento_pacote_itens_especificos IN SHARE ROW EXCLUSIVE MODE;
  IF EXISTS (SELECT 1 FROM fechamento_pacote_itens_especificos) THEN
    RAISE EXCEPTION '051 down: a fotografia de item específico já existe.';
  END IF;
END $$;

DROP TABLE IF EXISTS fechamento_pacote_itens_especificos;

COMMIT;
