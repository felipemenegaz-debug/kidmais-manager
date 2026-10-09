-- Rollback da 060. NÃO EXECUTAR sem autorização explícita (docs/OPERACAO_AGENTES.md).
-- Antes: WHATSAPP_ATENDIMENTO_ENABLED e WHATSAPP_ATENDIMENTO_RECEIVE_ENABLED desligadas e worker parado. O rollback de
-- código/flag NÃO exige este script: sem as flags nada é recebido nem enviado, e as tabelas podem ficar (histórico e
-- resultados incertos preservados). Este down só serve para remover a estrutura.
--
-- Fail closed, numa transação só:
--   1. lock_timeout curto: se a aplicação ainda segura as tabelas, aborta em vez de enfileirar;
--   2. trava ACCESS EXCLUSIVE antes de conferir: nenhuma mensagem nova entra depois da checagem;
--   3. mensagem em PROCESSANDO ou ENVIANDO recusa o down (trabalho em andamento), mesmo com descarte confirmado;
--   4. com qualquer linha gravada (conversa, mensagem, configuração, auditoria), exige exportação prévia e decisão
--      explícita de descarte: SET LOCAL kidmais.rollback_060_descartar_atendimento = 'sim'.
-- Status sem correspondência (whatsapp_atendimento_status) são transitórios e não exigem a decisão.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$ BEGIN
  IF to_regclass('public.whatsapp_atendimento_conversas') IS NULL THEN
    RAISE EXCEPTION '060 ausente: nada a remover.';
  END IF;
  -- Revisão final (09/10): com 065, 076, 077 ou 078 ainda aplicadas (total ou parcialmente), recusa ANTES de travar ou
  -- alterar qualquer coisa. Sem esta guarda o down apagava as tabelas da 060 e deixava prontas, arquivos e colunas das
  -- outras órfãos (e o down delas passava a falhar). Ordem: 078 → 077 → 076 → 065 → 060.
  IF to_regclass('public.whatsapp_atendimento_mensagens_prontas') IS NOT NULL
     OR to_regclass('public.whatsapp_atendimento_mensagens_prontas_favoritas') IS NOT NULL
     OR to_regclass('public.whatsapp_atendimento_arquivos') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.whatsapp_atendimento_conversas'::regclass AND attname IN ('nome_perfil', 'nome_perfil_em', 'contexto', 'passagem') AND NOT attisdropped)
     OR EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('public.whatsapp_atendimento_mensagens') AND attname IN ('midia_tipo', 'midia_pronta_id', 'origem_grupo_id', 'midia_arquivo_id', 'fonte') AND NOT attisdropped) THEN
    RAISE EXCEPTION 'Rollback da 060 recusado: 065, 076, 077 ou 078 ainda estão aplicadas (total ou parcialmente). Rode antes os downs delas. Ordem: 078 → 077 → 076 → 065 → 060.';
  END IF;
END $$;

LOCK TABLE whatsapp_atendimento_auditoria, whatsapp_atendimento_status, whatsapp_atendimento_mensagens,
  whatsapp_atendimento_conversas, whatsapp_atendimento_config IN ACCESS EXCLUSIVE MODE;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM whatsapp_atendimento_mensagens WHERE estado IN ('PROCESSANDO','ENVIANDO')) THEN
    RAISE EXCEPTION 'Rollback da 060 recusado: há mensagem em processamento ou envio. Pare o worker e aguarde o resultado.';
  END IF;
  IF (EXISTS (SELECT 1 FROM whatsapp_atendimento_conversas) OR EXISTS (SELECT 1 FROM whatsapp_atendimento_mensagens)
      OR EXISTS (SELECT 1 FROM whatsapp_atendimento_config) OR EXISTS (SELECT 1 FROM whatsapp_atendimento_auditoria))
     AND COALESCE(current_setting('kidmais.rollback_060_descartar_atendimento', true), '') <> 'sim' THEN
    RAISE EXCEPTION 'Rollback da 060 recusado: há atendimento gravado. Exporte as tabelas whatsapp_atendimento_* e confirme o descarte com SET LOCAL kidmais.rollback_060_descartar_atendimento = ''sim''.';
  END IF;
END $$;

DROP TABLE whatsapp_atendimento_auditoria;
DROP TABLE whatsapp_atendimento_status;
DROP TABLE whatsapp_atendimento_mensagens;
DROP TABLE whatsapp_atendimento_conversas;
DROP TABLE whatsapp_atendimento_config;

COMMIT;
