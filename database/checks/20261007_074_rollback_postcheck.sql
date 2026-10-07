-- Pós-rollback da 074: somente leitura. Colunas de mídia saíram; restrições da 073 voltaram com os nomes originais.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid IN ('public.whatsapp_atendimento_mensagens_prontas'::regclass, 'public.whatsapp_atendimento_mensagens'::regclass)
              AND attname IN ('midia_url', 'midia_tipo', 'midia_pronta_id', 'midia_pronta_versao') AND NOT attisdropped) THEN
    RAISE EXCEPTION 'pós-rollback 074: coluna de mídia ainda presente';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.whatsapp_atendimento_mensagens'::regclass AND conname LIKE 'whatsapp_mensagens_midia%')
     OR EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.whatsapp_atendimento_mensagens_prontas'::regclass AND conname LIKE 'whatsapp_prontas_midia%') THEN
    RAISE EXCEPTION 'pós-rollback 074: restrição de mídia ainda presente';
  END IF;
  -- Nenhuma linha fora das regras da 073 (o down remove as prontas de mídia e os atalhos novos só com a decisão explícita).
  IF EXISTS (SELECT 1 FROM whatsapp_atendimento_mensagens_prontas WHERE tipo NOT IN ('TEXTO', 'LINK', 'LINK_FECHAMENTO_INDIVIDUAL') OR atalho NOT IN ('TABELA_PRECOS', 'DISPONIBILIDADE_FECHAMENTO')) THEN
    RAISE EXCEPTION 'pós-rollback 074: mensagem pronta fora das regras da 073';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.whatsapp_atendimento_mensagens_prontas'::regclass AND conname IN ('whatsapp_prontas_tipo', 'whatsapp_prontas_atalho')) THEN
    RAISE EXCEPTION 'pós-rollback 074: restrição ampliada ainda presente';
  END IF;
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.whatsapp_atendimento_mensagens_prontas'::regclass AND conname = 'whatsapp_atendimento_mensagens_prontas_tipo_check')
       IS DISTINCT FROM 'CHECK ((tipo = ANY (ARRAY[''TEXTO''::text, ''LINK''::text, ''LINK_FECHAMENTO_INDIVIDUAL''::text])))'
     OR (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.whatsapp_atendimento_mensagens_prontas'::regclass AND conname = 'whatsapp_atendimento_mensagens_prontas_atalho_check')
       IS DISTINCT FROM 'CHECK ((atalho = ANY (ARRAY[''TABELA_PRECOS''::text, ''DISPONIBILIDADE_FECHAMENTO''::text])))' THEN
    RAISE EXCEPTION 'pós-rollback 074: restrições da 073 não restauradas';
  END IF;
  IF to_regclass('public.whatsapp_atendimento_mensagens_prontas_favoritas') IS NULL OR to_regclass('public.whatsapp_atendimento_conversas') IS NULL THEN
    RAISE EXCEPTION 'pós-rollback 074: a 073/060 foi afetada';
  END IF;
END $$;
SELECT '074 rollback postcheck OK' AS resultado;
