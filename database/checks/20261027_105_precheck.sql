-- Precheck da 105 (somente leitura): dependências presentes e tabelas MCP ainda ausentes.
DO $$
BEGIN
  IF to_regclass('public.usuarios_administrativos') IS NULL OR to_regclass('public.empresas') IS NULL OR to_regclass('public.memberships') IS NULL THEN
    RAISE EXCEPTION '105 precheck: usuarios_administrativos/empresas/memberships ausentes';
  END IF;
  IF to_regclass('public.mcp_oauth_concessoes') IS NOT NULL OR to_regclass('public.mcp_auditoria') IS NOT NULL THEN
    RAISE EXCEPTION '105 precheck: tabelas MCP já existem';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'gen_random_uuid') THEN
    RAISE EXCEPTION '105 precheck: gen_random_uuid indisponível';
  END IF;
END $$;
