-- =============================================================================
-- Kidmais Manager / iA.Fest — Migration 136: campanha com destino no site externo (kidmaisfestas.com)
-- Arquivo: 20261124_136_campanha_destino_externo.sql — LOCAL, PREPARADA, não aplicada em staging nem em production.
--
-- Plano: vault "Origem kidmaisfestas.com → WhatsApp" (correções do Astra r1, P2), decisão de Felipe em 24/11/2026:
-- "quero que funcione com os dois ao mesmo tempo". 136 conferida livre em origin/staging e nos ramos remotos (maior = 135).
-- Exige a 085.
--
-- Por quê: a empresa da integração (MARKETING_SITE_KIDMAIS_EMPRESA_ID) pode ter, ao mesmo tempo, campanhas que levam ao
-- site do iA.Fest (/s/<slug>) e campanhas que levam ao site externo. Antes, o destino era deduzido de site_id nulo, o
-- que trocava o link de TODA campanha antiga sem site. Agora a escolha é explícita por campanha.
--
-- O que muda: marketing_campanhas ganha destino_externo boolean NOT NULL DEFAULT false (nenhuma linha muda de destino; sem
-- backfill) e a restrição de que campanha externa não tem site do iA.Fest. Não cria gatilho nem índice. O gatilho da 085
-- (kidmais085_campanha_controle) é BEFORE UPDATE OR DELETE por linha e não dispara no ALTER TABLE.
-- O código tolera a coluna ausente: sem ela nenhuma campanha é externa, o painel não oferece o destino externo e os
-- cliques do site externo não gravam nada.
--
-- Rollback: database/rollback/20261124_136_campanha_destino_externo_down.sql (descarta a escolha; as campanhas externas
-- voltam a não registrar cliques nem atribuir pelo site externo).
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;

DO $$
BEGIN
  IF to_regclass('public.marketing_campanhas') IS NULL OR NOT EXISTS (
       SELECT 1 FROM pg_attribute WHERE attrelid = 'public.marketing_campanhas'::regclass AND attname = 'site_id' AND NOT attisdropped) THEN
    RAISE EXCEPTION '136: exige a 085';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.marketing_campanhas'::regclass AND attname = 'destino_externo' AND NOT attisdropped) THEN
    RAISE EXCEPTION '136: marketing_campanhas.destino_externo já existe';
  END IF;
END $$;

ALTER TABLE marketing_campanhas ADD COLUMN destino_externo boolean NOT NULL DEFAULT false;
ALTER TABLE marketing_campanhas ADD CONSTRAINT kidmais_136_destino_externo_sem_site CHECK (NOT (destino_externo AND site_id IS NOT NULL));
COMMENT ON COLUMN marketing_campanhas.destino_externo IS '136: o link da campanha leva ao site externo da empresa da integração (sem site do iA.Fest). Só essas campanhas recebem cliques e atribuição pelo site externo.';

COMMIT;
