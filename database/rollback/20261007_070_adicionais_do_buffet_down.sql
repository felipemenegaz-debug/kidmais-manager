-- 070 rollback. Recusa se algum adicional já foi criado a partir do buffet (não apaga adicional nem preço).
-- As categorias de adicional garantidas pela 070 ficam (podem ser usadas por adicionais anteriores).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = public, pg_catalog;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'adicionais' AND column_name = 'origem_buffet_item_id') THEN
    RAISE EXCEPTION '070 rollback: 070 não aplicada.';
  END IF;
END $$;

LOCK TABLE adicionais IN ACCESS EXCLUSIVE MODE;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM adicionais WHERE origem_buffet_item_id IS NOT NULL OR origem_buffet_categoria_id IS NOT NULL) THEN
    RAISE EXCEPTION '070 rollback recusado: há adicionais criados a partir do buffet.';
  END IF;
END $$;

DROP INDEX adicionais_empresa_origem_categoria_uk;
DROP INDEX adicionais_empresa_origem_item_uk;
ALTER TABLE adicionais
  DROP CONSTRAINT adicionais_escolhas_check,
  DROP CONSTRAINT adicionais_origem_empresa_check,
  DROP CONSTRAINT adicionais_origem_unica_check,
  DROP COLUMN escolhas_max,
  DROP COLUMN origem_buffet_categoria_id,
  DROP COLUMN origem_buffet_item_id;

COMMIT;
