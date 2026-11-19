-- 126 postcheck PREPARADO, NÃO EXECUTADO. Somente leitura. Confere os 3 CHECKs de escopos no formato da 126, validados.
BEGIN TRANSACTION READ ONLY;
SET LOCAL search_path = public, pg_catalog;
DO $$
BEGIN
  IF (SELECT count(*) FROM pg_constraint c
       WHERE ((c.conrelid = 'public.mcp_oauth_pedidos'::regclass AND c.conname = 'mcp_oauth_pedidos_escopos_check')
           OR (c.conrelid = 'public.mcp_oauth_concessoes'::regclass AND c.conname = 'mcp_oauth_concessoes_escopos_check')
           OR (c.conrelid = 'public.mcp_oauth_tokens'::regclass AND c.conname = 'mcp_oauth_tokens_escopos_check'))
         AND c.contype = 'c' AND c.convalidated
         AND pg_get_constraintdef(c.oid) = 'CHECK ((((cardinality(escopos) >= 1) AND (cardinality(escopos) <= 4)) AND (escopos <@ ARRAY[''agenda:read''::text, ''financeiro:read''::text, ''conhecimento:read''::text, ''clientes:read''::text])))') <> 3 THEN
    RAISE EXCEPTION '126 postcheck: CHECK de escopos fora do formato da 126';
  END IF;
END $$;
SELECT current_database() AS banco, true AS aprovado;
ROLLBACK;
