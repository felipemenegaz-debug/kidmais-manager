-- Postcheck da 060 (atendimento WhatsApp): somente leitura. Tabelas, chaves de isolamento por (empresa, ambiente),
-- deduplicação, uma resposta por entrada, retenção de status e restrições validadas.
DO $$
DECLARE
  item text;
BEGIN
  FOREACH item IN ARRAY ARRAY['whatsapp_atendimento_config', 'whatsapp_atendimento_conversas', 'whatsapp_atendimento_mensagens',
                              'whatsapp_atendimento_status', 'whatsapp_atendimento_auditoria'] LOOP
    IF to_regclass('public.' || item) IS NULL THEN
      RAISE EXCEPTION 'postcheck 060: tabela % ausente', item;
    END IF;
  END LOOP;
  -- Mensagens e auditoria só referenciam conversa pela chave composta (id, empresa, ambiente).
  FOREACH item IN ARRAY ARRAY['whatsapp_atendimento_mensagens', 'whatsapp_atendimento_auditoria'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint c
       WHERE c.conrelid = ('public.' || item)::regclass AND c.contype = 'f' AND c.convalidated
         AND c.confrelid = 'public.whatsapp_atendimento_conversas'::regclass AND array_length(c.conkey, 1) = 3
    ) THEN
      RAISE EXCEPTION 'postcheck 060: % sem chave composta validada para conversas', item;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.whatsapp_atendimento_mensagens'::regclass AND contype = 'u'
                   AND pg_get_constraintdef(oid) = 'UNIQUE (empresa_id, ambiente, externa_id)') THEN
    RAISE EXCEPTION 'postcheck 060: deduplicação por (empresa, ambiente, externa_id) ausente';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.whatsapp_atendimento_mensagens'::regclass AND contype = 'u'
                   AND pg_get_constraintdef(oid) = 'UNIQUE (origem_id)') THEN
    RAISE EXCEPTION 'postcheck 060: unicidade de resposta por entrada (origem_id) ausente';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.whatsapp_atendimento_conversas'::regclass AND contype = 'u'
                   AND pg_get_constraintdef(oid) = 'UNIQUE (empresa_id, ambiente, contato)') THEN
    RAISE EXCEPTION 'postcheck 060: conversa única por (empresa, ambiente, contato) ausente';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.whatsapp_atendimento_status'::regclass
                   AND attname = 'recebido_em' AND attnotnull AND NOT attisdropped) THEN
    RAISE EXCEPTION 'postcheck 060: retenção de status (recebido_em) ausente';
  END IF;
  FOREACH item IN ARRAY ARRAY['whatsapp_atendimento_fila', 'whatsapp_atendimento_ativas', 'whatsapp_atendimento_status_expiracao'] LOOP
    IF to_regclass('public.' || item) IS NULL THEN
      RAISE EXCEPTION 'postcheck 060: índice % ausente', item;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
              WHERE t.relname LIKE 'whatsapp_atendimento_%' AND NOT c.convalidated) THEN
    RAISE EXCEPTION 'postcheck 060: restrição não validada';
  END IF;
END $$;
SELECT '060 postcheck OK' AS resultado;
