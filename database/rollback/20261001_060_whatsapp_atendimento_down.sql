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
