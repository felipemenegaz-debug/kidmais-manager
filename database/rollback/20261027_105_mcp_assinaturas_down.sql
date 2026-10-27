-- Rollback da 105. NÃO é o desligamento do canal: para interromper o canal use MCP_ENABLED=false (sem apagar nada).
-- Só para desfazer a instalação ANTES de qualquer uso real: recusa se existir concessão (ativa ou não) ou auditoria,
-- para não apagar trilha de segurança. Depois de uso real, manter as tabelas e desligar a flag.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;
DO $$
BEGIN
  IF to_regclass('public.mcp_oauth_concessoes') IS NULL THEN
    RAISE EXCEPTION '105 down: 105 não instalada; nada alterado';
  END IF;
  IF EXISTS (SELECT 1 FROM public.mcp_oauth_concessoes) OR EXISTS (SELECT 1 FROM public.mcp_auditoria) THEN
    RAISE EXCEPTION '105 down: há concessões ou auditoria; desligue MCP_ENABLED em vez de remover; nada alterado';
  END IF;
END $$;
DROP TABLE public.mcp_oauth_tokens;
DROP TABLE public.mcp_oauth_codigos;
DROP TRIGGER mcp_oauth_concessoes_revogacao_imutavel ON public.mcp_oauth_concessoes;
DROP TABLE public.mcp_oauth_concessoes;
DROP FUNCTION public.mcp_oauth_concessao_revogacao_imutavel();
DROP TABLE public.mcp_oauth_pedidos;
DROP TABLE public.mcp_oauth_clientes;
DROP TABLE public.mcp_auditoria;
COMMIT;
