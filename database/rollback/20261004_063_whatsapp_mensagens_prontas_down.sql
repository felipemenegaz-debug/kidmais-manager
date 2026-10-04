-- Rollback da 063. NÃO EXECUTAR sem autorização explícita (docs/OPERACAO_AGENTES.md).
-- O rollback de código não exige este script: sem as tabelas a biblioteca só fica indisponível na tela. Este down
-- serve para remover a estrutura. Não toca a 060 (conversas, mensagens e auditoria ficam intactas).
--
-- Fail closed, numa transação só:
--   1. lock_timeout curto: se a aplicação ainda segura as tabelas, aborta em vez de enfileirar;
--   2. trava ACCESS EXCLUSIVE antes de conferir;
--   3. com mensagem pronta gravada, exige exportação prévia e decisão explícita de descarte:
--      SET LOCAL kidmais.rollback_063_descartar_prontas = 'sim'.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$ BEGIN
  IF to_regclass('public.whatsapp_atendimento_mensagens_prontas') IS NULL THEN
    RAISE EXCEPTION '063 ausente: nada a remover.';
  END IF;
END $$;

LOCK TABLE whatsapp_atendimento_mensagens_prontas_favoritas, whatsapp_atendimento_mensagens_prontas IN ACCESS EXCLUSIVE MODE;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM whatsapp_atendimento_mensagens_prontas)
     AND COALESCE(current_setting('kidmais.rollback_063_descartar_prontas', true), '') <> 'sim' THEN
    RAISE EXCEPTION 'Rollback da 063 recusado: há mensagens prontas gravadas. Exporte whatsapp_atendimento_mensagens_prontas* e confirme o descarte com SET LOCAL kidmais.rollback_063_descartar_prontas = ''sim''.';
  END IF;
END $$;

DROP TABLE whatsapp_atendimento_mensagens_prontas_favoritas;
DROP TABLE whatsapp_atendimento_mensagens_prontas;

COMMIT;
