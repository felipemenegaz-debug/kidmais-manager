-- Pós-rollback da 065: somente leitura. As colunas de nome de perfil saíram; a conversa da 060 ficou intacta.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.whatsapp_atendimento_conversas'::regclass
              AND attname IN ('nome_perfil', 'nome_perfil_em') AND NOT attisdropped) THEN
    RAISE EXCEPTION 'pós-rollback 065: coluna de nome de perfil ainda presente';
  END IF;
  IF to_regclass('public.whatsapp_atendimento_conversas') IS NULL OR to_regclass('public.whatsapp_atendimento_mensagens') IS NULL
     OR to_regclass('public.whatsapp_atendimento_auditoria') IS NULL THEN
    RAISE EXCEPTION 'pós-rollback 065: a 060 foi afetada';
  END IF;
END $$;
SELECT '065 rollback postcheck OK' AS resultado;
