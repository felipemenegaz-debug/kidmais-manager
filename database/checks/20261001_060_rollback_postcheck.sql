-- Verificação pós-rollback da 060: SOMENTE LEITURA. Nenhum objeto da 060 sobrou e o Core continua intacto.
DO $$
DECLARE
  item text;
BEGIN
  FOREACH item IN ARRAY ARRAY['whatsapp_atendimento_config', 'whatsapp_atendimento_conversas', 'whatsapp_atendimento_mensagens',
                              'whatsapp_atendimento_status', 'whatsapp_atendimento_auditoria'] LOOP
    IF to_regclass('public.' || item) IS NOT NULL THEN
      RAISE EXCEPTION '060 pós-rollback: % ainda existe', item;
    END IF;
  END LOOP;
  FOREACH item IN ARRAY ARRAY['empresas', 'usuarios_administrativos', 'memberships'] LOOP
    IF to_regclass('public.' || item) IS NULL THEN
      RAISE EXCEPTION '060 pós-rollback: tabela do Core % ausente', item;
    END IF;
  END LOOP;
END $$;
SELECT '060 pós-rollback OK' AS resultado;
