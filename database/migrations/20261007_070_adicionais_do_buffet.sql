-- 070 — Adicionais ligados ao buffet: um item ou uma categoria do buffet (catálogo global) pode virar um adicional
-- vendável DA EMPRESA, com preço na tabela da empresa e oferta por pacote.
--
-- NÃO APLICADA. Exige 021 e 031, e autorização explícita (docs/OPERACAO_AGENTES.md) para qualquer banco.
--
--   1. adicionais.origem_buffet_item_id: o adicional é aquele item do buffet (ex.: "Coxinha extra"). Usa o mesmo código
--      do item, então continua fora dos pacotes que já incluem o item no buffet.
--   2. adicionais.origem_buffet_categoria_id + escolhas_max: o adicional é a categoria inteira (ex.: "Cento de
--      salgados extra"); o cliente escolhe até escolhas_max itens ativos da categoria. As escolhas ficam congeladas em
--      fechamento_adicionais.observacoes ("Escolhas: ..."), que já vai para a revisão e para o contrato.
--   3. Uma origem por adicional e um adicional por origem em cada empresa. O buffet continua global e intocado.
--   4. Categorias de adicional usadas pelas telas (BUFFET, MESA, DECORACAO, EXTRA, BEBIDA, COMBO) garantidas.
-- Nenhuma linha existente de adicionais é alterada.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = public, pg_catalog;

DO $$ BEGIN
  IF to_regclass('public.adicional_categorias') IS NULL OR to_regclass('public.buffet_categorias') IS NULL
     OR to_regclass('public.buffet_itens') IS NULL THEN
    RAISE EXCEPTION '070 exige a 021.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'adicionais' AND column_name = 'empresa_id') THEN
    RAISE EXCEPTION '070 exige a 031.';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'adicionais' AND column_name = 'origem_buffet_item_id') THEN
    RAISE EXCEPTION '070 já aplicada.';
  END IF;
END $$;

ALTER TABLE adicionais
  ADD COLUMN origem_buffet_item_id uuid REFERENCES buffet_itens(id) ON DELETE RESTRICT,
  ADD COLUMN origem_buffet_categoria_id uuid REFERENCES buffet_categorias(id) ON DELETE RESTRICT,
  ADD COLUMN escolhas_max smallint,
  ADD CONSTRAINT adicionais_origem_unica_check
    CHECK (origem_buffet_item_id IS NULL OR origem_buffet_categoria_id IS NULL),
  ADD CONSTRAINT adicionais_origem_empresa_check
    CHECK ((origem_buffet_item_id IS NULL AND origem_buffet_categoria_id IS NULL) OR empresa_id IS NOT NULL),
  ADD CONSTRAINT adicionais_escolhas_check
    CHECK (escolhas_max IS NULL OR (origem_buffet_categoria_id IS NOT NULL AND escolhas_max BETWEEN 1 AND 30));

CREATE UNIQUE INDEX adicionais_empresa_origem_item_uk
  ON adicionais (empresa_id, origem_buffet_item_id) WHERE origem_buffet_item_id IS NOT NULL;
CREATE UNIQUE INDEX adicionais_empresa_origem_categoria_uk
  ON adicionais (empresa_id, origem_buffet_categoria_id) WHERE origem_buffet_categoria_id IS NOT NULL;

INSERT INTO adicional_categorias (codigo, nome, ordem_exibicao)
VALUES ('BUFFET', 'Buffet', 1), ('MESA', 'Mesas especiais', 2), ('DECORACAO', 'Decoração', 3),
       ('EXTRA', 'Extras', 4), ('BEBIDA', 'Bebidas', 5), ('COMBO', 'Combos', 6)
ON CONFLICT (codigo) DO NOTHING;

COMMENT ON COLUMN adicionais.origem_buffet_item_id IS '070: adicional vendido a partir de um item do buffet (mesmo código do item).';
COMMENT ON COLUMN adicionais.origem_buffet_categoria_id IS '070: adicional da categoria do buffet; o cliente escolhe os itens.';
COMMENT ON COLUMN adicionais.escolhas_max IS '070: máximo de itens que o cliente escolhe no adicional de categoria.';

COMMIT;
