-- Pós-rollback da 064: somente leitura. As tabelas da biblioteca saíram; a 060 (atendimento) ficou intacta.
DO $$
BEGIN
  IF to_regclass('public.whatsapp_atendimento_mensagens_prontas') IS NOT NULL
     OR to_regclass('public.whatsapp_atendimento_mensagens_prontas_favoritas') IS NOT NULL THEN
    RAISE EXCEPTION 'pós-rollback 064: tabela da biblioteca ainda presente';
  END IF;
  IF to_regclass('public.whatsapp_atendimento_conversas') IS NULL OR to_regclass('public.whatsapp_atendimento_mensagens') IS NULL
     OR to_regclass('public.whatsapp_atendimento_auditoria') IS NULL THEN
    RAISE EXCEPTION 'pós-rollback 064: a 060 foi afetada';
  END IF;
END $$;
SELECT '064 rollback postcheck OK' AS resultado;
