-- 126 precheck PREPARADO, NÃO EXECUTADO. Somente leitura. Confere a 105 com o CHECK de escopos original e nada da 126.
BEGIN TRANSACTION READ ONLY;
SET LOCAL search_path = public, pg_catalog;
DO $$
BEGIN
  IF to_regclass('public.mcp_oauth_pedidos') IS NULL OR to_regclass('public.mcp_oauth_concessoes') IS NULL
     OR to_regclass('public.mcp_oauth_tokens') IS NULL THEN
    RAISE EXCEPTION '126 precheck: exige a 105';
  END IF;
  IF (SELECT count(*) FROM pg_constraint c
       WHERE ((c.conrelid = 'public.mcp_oauth_pedidos'::regclass AND c.conname = 'mcp_oauth_pedidos_escopos_check')
           OR (c.conrelid = 'public.mcp_oauth_concessoes'::regclass AND c.conname = 'mcp_oauth_concessoes_escopos_check')
           OR (c.conrelid = 'public.mcp_oauth_tokens'::regclass AND c.conname = 'mcp_oauth_tokens_escopos_check'))
         AND c.contype = 'c' AND c.convalidated
         AND pg_get_constraintdef(c.oid) = 'CHECK ((((cardinality(escopos) >= 1) AND (cardinality(escopos) <= 3)) AND (escopos <@ ARRAY[''agenda:read''::text, ''financeiro:read''::text, ''conhecimento:read''::text])))') <> 3 THEN
    RAISE EXCEPTION '126 precheck: CHECK de escopos fora do formato da 105 (ou 126 já presente)';
  END IF;
END $$;
SELECT current_database() AS banco, true AS aprovado;
ROLLBACK;
