-- =============================================================================
-- Kidmais Manager / iA.Fest — Migration 126: escopo OAuth `clientes:read` do canal MCP (etapa 0b)
-- Arquivo: 20261118_126_mcp_escopo_clientes.sql — LOCAL, PREPARADA, não aplicada em staging nem em production.
--
-- Plano: vault "Plano acoes confirmadas MCP 20261116", seção "0b — com nomes". 126 conferida livre em 18/11/2026 (Fila
-- única: liberada pela área da família em 16/11; nenhuma origin/*, clone local ou nota usa 126). Exige a 105.
--
-- Troca SÓ o CHECK de escopos das 3 tabelas que guardam escopo (pedidos, concessões e tokens): cardinalidade 1..4 e o
-- escopo novo `clientes:read` na lista fechada. Mesmo nome de restrição; nenhuma coluna, índice, gatilho ou linha muda.
-- O CHECK novo é MAIS LARGO que o da 105, então toda linha existente continua válida (validada no próprio ADD).
--
-- Ordem de publicação: a 126 vai ANTES do código da 0b. Código da 0b sem a 126 recusa a conexão que pedir
-- `clientes:read` (CHECK 23514 vira indisponível 503; nada é gravado); conexões só com os escopos da 0a seguem iguais.
-- Os conferidores da 105 (scripts/migration-105-definicoes.cjs, migration-105-relacoes.cjs, conferencia-b5-105.cjs)
-- fixam o CHECK da 105: depois da 126 eles acusam diferença nesses 3 CHECKs (esperado; ver a nota do vault).
--
-- Rollback: database/rollback/20261118_126_mcp_escopo_clientes_down.sql (recusa se houver qualquer linha com
-- `clientes:read`; não apaga nada sozinho).
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;

DO $$
BEGIN
  IF to_regclass('public.mcp_oauth_pedidos') IS NULL OR to_regclass('public.mcp_oauth_concessoes') IS NULL
     OR to_regclass('public.mcp_oauth_tokens') IS NULL THEN
    RAISE EXCEPTION '126: exige a 105';
  END IF;
END $$;

-- Trava as 3 tabelas (sempre nesta ordem, a mesma do down) ANTES de conferir: nenhum CHECK muda entre a conferência e a
-- troca. ACCESS EXCLUSIVE é o modo que o ALTER pediria; pedir antes evita escalar a trava no meio da transação.
LOCK TABLE public.mcp_oauth_pedidos, public.mcp_oauth_concessoes, public.mcp_oauth_tokens IN ACCESS EXCLUSIVE MODE;

-- Confere cada par (tabela, restrição): definição EXATA da 105, CHECK e validada. Qualquer outra coisa (126 parcial,
-- CHECK divergente com o mesmo nome, restrição NOT VALID, nome em outra tabela) recusa sem alterar nada.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint c
              WHERE ((c.conrelid = 'public.mcp_oauth_pedidos'::regclass AND c.conname = 'mcp_oauth_pedidos_escopos_check')
           OR (c.conrelid = 'public.mcp_oauth_concessoes'::regclass AND c.conname = 'mcp_oauth_concessoes_escopos_check')
           OR (c.conrelid = 'public.mcp_oauth_tokens'::regclass AND c.conname = 'mcp_oauth_tokens_escopos_check'))
                AND pg_get_constraintdef(c.oid) = 'CHECK ((((cardinality(escopos) >= 1) AND (cardinality(escopos) <= 4)) AND (escopos <@ ARRAY[''agenda:read''::text, ''financeiro:read''::text, ''conhecimento:read''::text, ''clientes:read''::text])))') THEN
    RAISE EXCEPTION '126: já (parcialmente) aplicada';
  END IF;
  IF (SELECT count(*) FROM pg_constraint c
       WHERE ((c.conrelid = 'public.mcp_oauth_pedidos'::regclass AND c.conname = 'mcp_oauth_pedidos_escopos_check')
           OR (c.conrelid = 'public.mcp_oauth_concessoes'::regclass AND c.conname = 'mcp_oauth_concessoes_escopos_check')
           OR (c.conrelid = 'public.mcp_oauth_tokens'::regclass AND c.conname = 'mcp_oauth_tokens_escopos_check'))
         AND c.contype = 'c' AND c.convalidated
         AND pg_get_constraintdef(c.oid) = 'CHECK ((((cardinality(escopos) >= 1) AND (cardinality(escopos) <= 3)) AND (escopos <@ ARRAY[''agenda:read''::text, ''financeiro:read''::text, ''conhecimento:read''::text])))') <> 3 THEN
    RAISE EXCEPTION '126: CHECK de escopos fora do formato da 105';
  END IF;
END $$;

ALTER TABLE public.mcp_oauth_pedidos
  DROP CONSTRAINT mcp_oauth_pedidos_escopos_check,
  ADD CONSTRAINT mcp_oauth_pedidos_escopos_check
    CHECK (cardinality(escopos) BETWEEN 1 AND 4 AND escopos <@ ARRAY['agenda:read','financeiro:read','conhecimento:read','clientes:read']);

ALTER TABLE public.mcp_oauth_concessoes
  DROP CONSTRAINT mcp_oauth_concessoes_escopos_check,
  ADD CONSTRAINT mcp_oauth_concessoes_escopos_check
    CHECK (cardinality(escopos) BETWEEN 1 AND 4 AND escopos <@ ARRAY['agenda:read','financeiro:read','conhecimento:read','clientes:read']);

ALTER TABLE public.mcp_oauth_tokens
  DROP CONSTRAINT mcp_oauth_tokens_escopos_check,
  ADD CONSTRAINT mcp_oauth_tokens_escopos_check
    CHECK (cardinality(escopos) BETWEEN 1 AND 4 AND escopos <@ ARRAY['agenda:read','financeiro:read','conhecimento:read','clientes:read']);

COMMIT;
