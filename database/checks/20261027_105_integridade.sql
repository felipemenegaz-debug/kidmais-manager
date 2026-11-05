-- Integridade da 105 (somente leitura, só catálogo; REPETÍVEL a qualquer momento depois da aplicação, ao contrário do
-- postcheck, que exige as tabelas vazias). Devolve integra_105 = true só se o desenho da migration estiver inteiro:
--   * as 6 tabelas mcp_* (relkind r), cada uma com o número exato de colunas e de restrições CHECK/PK/UNIQUE/FK
--     (sem contar NOT NULL, que o PostgreSQL 18 passou a guardar como restrição);
--   * os 11 índices nomeados, com mcp_oauth_concessoes_ativa_uk ÚNICO e PARCIAL;
--   * a função mcp_oauth_concessao_revogacao_imutavel com o corpo exato (sha256 do prosrc) e o gatilho BEFORE UPDATE
--     FOR EACH ROW habilitado em mcp_oauth_concessoes chamando essa função.
-- Usada pelo aplicador da 105 (scripts/migration-105-comum.cjs) dentro da transação da migration e depois, em READ ONLY.
SELECT (
  (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
      AND c.relname IN ('mcp_oauth_clientes', 'mcp_oauth_pedidos', 'mcp_oauth_concessoes', 'mcp_oauth_codigos', 'mcp_oauth_tokens', 'mcp_auditoria')) = 6
  AND NOT EXISTS (
    SELECT 1 FROM (VALUES
      ('mcp_oauth_clientes', 5, 3, 1, 0, 0),
      ('mcp_oauth_pedidos', 11, 8, 1, 0, 1),
      ('mcp_oauth_concessoes', 14, 6, 1, 0, 4),
      ('mcp_oauth_codigos', 7, 4, 1, 0, 1),
      ('mcp_oauth_tokens', 8, 6, 1, 1, 1),
      ('mcp_auditoria', 12, 7, 1, 0, 0)
    ) AS esperado (tabela, colunas, checks, pks, uniques, fks)
    WHERE to_regclass('public.' || esperado.tabela) IS NULL
       OR (SELECT count(*) FROM pg_attribute a WHERE a.attrelid = to_regclass('public.' || esperado.tabela) AND a.attnum > 0 AND NOT a.attisdropped) <> esperado.colunas
       OR (SELECT count(*) FROM pg_constraint k WHERE k.conrelid = to_regclass('public.' || esperado.tabela) AND k.contype = 'c') <> esperado.checks
       OR (SELECT count(*) FROM pg_constraint k WHERE k.conrelid = to_regclass('public.' || esperado.tabela) AND k.contype = 'p') <> esperado.pks
       OR (SELECT count(*) FROM pg_constraint k WHERE k.conrelid = to_regclass('public.' || esperado.tabela) AND k.contype = 'u') <> esperado.uniques
       OR (SELECT count(*) FROM pg_constraint k WHERE k.conrelid = to_regclass('public.' || esperado.tabela) AND k.contype = 'f') <> esperado.fks
  )
  AND (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'i' AND c.relname IN (
      'mcp_oauth_pedidos_expira_idx', 'mcp_oauth_pedidos_cliente_idx', 'mcp_oauth_concessoes_ativa_uk', 'mcp_oauth_concessoes_usuario_idx',
      'mcp_oauth_concessoes_empresa_idx', 'mcp_oauth_codigos_concessao_idx', 'mcp_oauth_codigos_expira_idx', 'mcp_oauth_tokens_concessao_idx',
      'mcp_oauth_tokens_expira_idx', 'mcp_auditoria_ocorrido_idx', 'mcp_auditoria_empresa_idx')) = 11
  AND EXISTS (SELECT 1 FROM pg_index i WHERE i.indexrelid = to_regclass('public.mcp_oauth_concessoes_ativa_uk')
    AND i.indrelid = to_regclass('public.mcp_oauth_concessoes') AND i.indisunique AND i.indpred IS NOT NULL AND i.indnatts = 3)
  AND EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'mcp_oauth_concessao_revogacao_imutavel' AND p.pronargs = 0
      AND encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') = '71cd349698aff45d2d36d5a1355466dbaa1db3d32115b4c9d2779c34ac87a862')
  AND EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
    WHERE t.tgrelid = to_regclass('public.mcp_oauth_concessoes') AND t.tgname = 'mcp_oauth_concessoes_revogacao_imutavel'
      AND NOT t.tgisinternal AND t.tgenabled = 'O' AND t.tgtype = 19 AND p.proname = 'mcp_oauth_concessao_revogacao_imutavel')
) AS integra_105;
