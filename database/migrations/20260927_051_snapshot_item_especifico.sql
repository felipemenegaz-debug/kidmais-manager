-- Fotografa o item específico incluído no pacote, inclusive sem categoria.
-- A composição de categoria continua na tabela existente.
BEGIN;

DO $$ BEGIN
  IF to_regclass('public.fechamento_pacote_snapshots') IS NULL
     OR to_regclass('public.buffet_itens') IS NULL THEN
    RAISE EXCEPTION '051 exige a fotografia do pacote e o item de buffet.';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS fechamento_pacote_itens_especificos (
  snapshot_id uuid NOT NULL REFERENCES fechamento_pacote_snapshots(id) ON DELETE RESTRICT,
  item_id uuid NOT NULL REFERENCES buffet_itens(id) ON DELETE RESTRICT,
  categoria_id uuid REFERENCES buffet_categorias(id) ON DELETE RESTRICT,
  codigo_aplicado text NOT NULL,
  nome_aplicado text NOT NULL,
  criado_em timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (snapshot_id, item_id),
  CONSTRAINT fechamento_pacote_itens_especificos_texto_check CHECK (
    btrim(codigo_aplicado) <> '' AND btrim(nome_aplicado) <> ''
  )
);

DROP TRIGGER IF EXISTS fechamento_pacote_itens_especificos_imutavel ON fechamento_pacote_itens_especificos;
CREATE TRIGGER fechamento_pacote_itens_especificos_imutavel
  BEFORE UPDATE OR DELETE ON fechamento_pacote_itens_especificos
  FOR EACH ROW EXECUTE FUNCTION kidmais_029_fotografia_imutavel();

COMMIT;
