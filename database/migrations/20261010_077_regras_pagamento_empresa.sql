-- 077 — Regras de pagamento por empresa. PREPARADA, NÃO APLICADA.
-- Antes da 077 todas as empresas usam o legado (PIX à vista 10%, parcelado 3%, cartão Cielo, selo -15% seg–qui).
-- Depois: cada condição nova grava o percentual da empresa; empresa sem linha = sem desconto automático.
-- A Kidmais (empresas.codigo = 'kidmais', se existir neste banco) recebe exatamente as regras legadas: nada muda para ela.
-- Condições e contratos já gravados não são tocados (sem o campo, continuam no legado).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = public, pg_catalog;

DO $$ BEGIN
  IF to_regclass('public.empresas') IS NULL THEN
    RAISE EXCEPTION '077 exige empresas (031).';
  END IF;
  IF to_regclass('public.empresa_regras_pagamento') IS NOT NULL THEN
    RAISE EXCEPTION '077 já aplicada.';
  END IF;
END $$;

CREATE TABLE empresa_regras_pagamento (
  empresa_id uuid PRIMARY KEY REFERENCES empresas(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  pix_avista_percentual integer NOT NULL CHECK (pix_avista_percentual BETWEEN 0 AND 100),
  pix_parcelado_percentual integer NOT NULL CHECK (pix_parcelado_percentual BETWEEN 0 AND 100),
  cartao_rotulo text NOT NULL CHECK (char_length(btrim(cartao_rotulo)) BETWEEN 2 AND 40),
  desconto_dia_util boolean NOT NULL,
  motivo text NOT NULL CHECK (char_length(btrim(motivo)) BETWEEN 5 AND 300),
  criado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  atualizado_em timestamptz NOT NULL DEFAULT clock_timestamp()
);

INSERT INTO empresa_regras_pagamento (empresa_id, pix_avista_percentual, pix_parcelado_percentual, cartao_rotulo, desconto_dia_util, motivo)
SELECT id, 10, 3, 'Cielo', true, '077: regras legadas preservadas para a Kidmais'
  FROM empresas WHERE codigo = 'kidmais';

COMMIT;
