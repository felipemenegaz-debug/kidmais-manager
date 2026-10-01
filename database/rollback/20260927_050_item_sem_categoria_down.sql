BEGIN;

DO $$ BEGIN
  IF to_regclass('public.buffet_itens') IS NULL THEN
    RAISE EXCEPTION '050 down: buffet ausente.';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('kidmais-050-down'));
  LOCK TABLE public.buffet_itens IN SHARE ROW EXCLUSIVE MODE;
  IF to_regclass('public.pacote_itens_especificos') IS NOT NULL THEN
    LOCK TABLE public.pacote_itens_especificos IN SHARE ROW EXCLUSIVE MODE;
  END IF;
  IF EXISTS (SELECT 1 FROM buffet_itens WHERE categoria_id IS NULL) THEN
    RAISE EXCEPTION '050 down: ainda há item sem categoria.';
  END IF;
  IF to_regclass('public.pacote_itens_especificos') IS NOT NULL
     AND EXISTS (SELECT 1 FROM pacote_itens_especificos) THEN
    RAISE EXCEPTION '050 down: ainda há item específico em pacote.';
  END IF;
END $$;

DROP TABLE IF EXISTS pacote_itens_especificos;
DROP INDEX IF EXISTS buffet_itens_codigo_sem_categoria_uk;
ALTER TABLE buffet_itens ALTER COLUMN categoria_id SET NOT NULL;

COMMIT;
