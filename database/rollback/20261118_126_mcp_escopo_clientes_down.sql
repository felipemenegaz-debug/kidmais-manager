-- Rollback da 126 (escopo `clientes:read`) — PREPARADO, NÃO EXECUTADO.
-- Recusa se houver QUALQUER linha (pedido, concessão ou token, inclusive revogados ou expirados) com `clientes:read`:
-- quem decide o que fazer com essas linhas é uma pessoa, nunca este script. Sem linhas assim, volta o CHECK da 105.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;

-- Trava as 3 tabelas (mesma ordem da 126) ANTES de qualquer conferência: nada entra nem muda entre conferir e trocar.
LOCK TABLE public.mcp_oauth_pedidos, public.mcp_oauth_concessoes, public.mcp_oauth_tokens IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF (SELECT count(*) FROM pg_constraint c
       WHERE ((c.conrelid = 'public.mcp_oauth_pedidos'::regclass AND c.conname = 'mcp_oauth_pedidos_escopos_check')
           OR (c.conrelid = 'public.mcp_oauth_concessoes'::regclass AND c.conname = 'mcp_oauth_concessoes_escopos_check')
           OR (c.conrelid = 'public.mcp_oauth_tokens'::regclass AND c.conname = 'mcp_oauth_tokens_escopos_check'))
         AND c.contype = 'c' AND c.convalidated
         AND pg_get_constraintdef(c.oid) = 'CHECK ((((cardinality(escopos) >= 1) AND (cardinality(escopos) <= 4)) AND (escopos <@ ARRAY[''agenda:read''::text, ''financeiro:read''::text, ''conhecimento:read''::text, ''clientes:read''::text])))') <> 3 THEN
    RAISE EXCEPTION '126 down: a 126 não está aplicada inteira (definição exata nas 3 tabelas)';
  END IF;
  IF EXISTS (SELECT 1 FROM public.mcp_oauth_pedidos WHERE 'clientes:read' = ANY (escopos))
     OR EXISTS (SELECT 1 FROM public.mcp_oauth_concessoes WHERE 'clientes:read' = ANY (escopos))
     OR EXISTS (SELECT 1 FROM public.mcp_oauth_tokens WHERE 'clientes:read' = ANY (escopos)) THEN
    RAISE EXCEPTION '126 down: há linhas com clientes:read; nada foi alterado';
  END IF;
END $$;

ALTER TABLE public.mcp_oauth_pedidos
  DROP CONSTRAINT mcp_oauth_pedidos_escopos_check,
  ADD CONSTRAINT mcp_oauth_pedidos_escopos_check
    CHECK (cardinality(escopos) BETWEEN 1 AND 3 AND escopos <@ ARRAY['agenda:read','financeiro:read','conhecimento:read']);
ALTER TABLE public.mcp_oauth_concessoes
  DROP CONSTRAINT mcp_oauth_concessoes_escopos_check,
  ADD CONSTRAINT mcp_oauth_concessoes_escopos_check
    CHECK (cardinality(escopos) BETWEEN 1 AND 3 AND escopos <@ ARRAY['agenda:read','financeiro:read','conhecimento:read']);
ALTER TABLE public.mcp_oauth_tokens
  DROP CONSTRAINT mcp_oauth_tokens_escopos_check,
  ADD CONSTRAINT mcp_oauth_tokens_escopos_check
    CHECK (cardinality(escopos) BETWEEN 1 AND 3 AND escopos <@ ARRAY['agenda:read','financeiro:read','conhecimento:read']);
COMMIT;
