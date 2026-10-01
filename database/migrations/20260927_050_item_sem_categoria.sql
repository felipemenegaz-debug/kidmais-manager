-- Item de buffet pode ficar sem categoria. O vínculo específico do pacote
-- não exige a regra da categoria. Não apaga referência em uso.
-- Não cria empresa_id e não autoriza uma membership a alterar o catálogo compartilhado.
BEGIN;

DO $$ BEGIN
  IF to_regclass('public.buffet_itens') IS NULL OR to_regclass('public.pacotes') IS NULL THEN
    RAISE EXCEPTION '050 exige o catálogo de buffet.';
  END IF;
END $$;

ALTER TABLE buffet_itens ALTER COLUMN categoria_id DROP NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS buffet_itens_codigo_sem_categoria_uk
  ON buffet_itens (codigo)
  WHERE categoria_id IS NULL;

CREATE TABLE IF NOT EXISTS pacote_itens_especificos (
  pacote_id uuid NOT NULL REFERENCES pacotes(id) ON DELETE RESTRICT,
  item_id uuid NOT NULL REFERENCES buffet_itens(id) ON DELETE RESTRICT,
  criado_em timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (pacote_id, item_id)
);

COMMIT;
