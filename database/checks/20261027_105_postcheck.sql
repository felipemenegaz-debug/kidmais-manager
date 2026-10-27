-- Postcheck da 105 (somente leitura): seis tabelas, índice de concessão ativa única, gatilho de revogação imutável, vazias.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['mcp_oauth_clientes','mcp_oauth_pedidos','mcp_oauth_concessoes','mcp_oauth_codigos','mcp_oauth_tokens','mcp_auditoria'] LOOP
    IF to_regclass('public.' || t) IS NULL THEN RAISE EXCEPTION '105 postcheck: tabela % ausente', t; END IF;
  END LOOP;
  IF to_regclass('public.mcp_oauth_concessoes_ativa_uk') IS NULL THEN RAISE EXCEPTION '105 postcheck: índice de concessão ativa ausente'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'mcp_oauth_concessoes_revogacao_imutavel' AND NOT tgisinternal) THEN
    RAISE EXCEPTION '105 postcheck: gatilho de revogação imutável ausente';
  END IF;
  IF EXISTS (SELECT 1 FROM public.mcp_oauth_concessoes) OR EXISTS (SELECT 1 FROM public.mcp_oauth_tokens) THEN
    RAISE EXCEPTION '105 postcheck: tabelas deveriam estar vazias logo após a aplicação';
  END IF;
END $$;
