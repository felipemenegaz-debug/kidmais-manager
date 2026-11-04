-- PREPARADO, NÃO EXECUTADO. Volta à base anterior à 117. As duas tabelas guardam só CONTROLE (vez de cada empresa no
-- rodízio e identificadores do provedor vistos em mais de uma saída); nenhuma mensagem, conversa ou dado de cliente.
-- Ordem obrigatória (plano r6.1, §7): WHATSAPP_ATENDIMENTO_MULTIEMPRESA desligada e o critério de corte cumprido ANTES
-- (sem a 117 o código compatível volta sozinho ao modo PILOTO e o status segue a correlação legada com a contagem de
-- unicidade). Marcas de colisão ainda vigentes perdem-se aqui: a duplicação continua detectada pela contagem enquanto as
-- duas saídas existirem (risco residual aceito no plano). Uma transação só: recusado = nenhum efeito.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;
DO $$ BEGIN
  IF to_regclass('public.whatsapp_atendimento_rodizio') IS NULL OR to_regclass('public.whatsapp_atendimento_status_colisoes') IS NULL
    THEN RAISE EXCEPTION '117: rollback recusado; a 117 não está (inteira) presente.'; END IF;
END $$;
DROP TABLE public.whatsapp_atendimento_rodizio;
DROP TABLE public.whatsapp_atendimento_status_colisoes;
DROP INDEX IF EXISTS public.whatsapp_atendimento_mensagens_ambiente_provedor_idx;
COMMIT;
