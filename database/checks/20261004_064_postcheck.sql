-- Postcheck da 064 (mensagens prontas do atendimento): somente leitura. Tabelas, isolamento por (empresa, ambiente),
-- link só no tipo LINK, atalho único por empresa, favoritas presas à mesma empresa e restrições validadas.
DO $$
DECLARE
  item text;
BEGIN
  FOREACH item IN ARRAY ARRAY['whatsapp_atendimento_mensagens_prontas', 'whatsapp_atendimento_mensagens_prontas_favoritas'] LOOP
    IF to_regclass('public.' || item) IS NULL THEN
      RAISE EXCEPTION 'postcheck 064: tabela % ausente', item;
    END IF;
  END LOOP;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
     WHERE c.conrelid = 'public.whatsapp_atendimento_mensagens_prontas_favoritas'::regclass AND c.contype = 'f' AND c.convalidated
       AND c.confrelid = 'public.whatsapp_atendimento_mensagens_prontas'::regclass AND array_length(c.conkey, 1) = 3
  ) THEN
    RAISE EXCEPTION 'postcheck 064: favoritas sem chave composta validada (mensagem, empresa, ambiente)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.whatsapp_atendimento_mensagens_prontas'::regclass
                   AND conname = 'whatsapp_prontas_link_por_tipo' AND convalidated) THEN
    RAISE EXCEPTION 'postcheck 064: regra de link por tipo ausente';
  END IF;
  FOREACH item IN ARRAY ARRAY['whatsapp_prontas_atalho_unico', 'whatsapp_prontas_titulo_unico', 'whatsapp_prontas_lista', 'whatsapp_prontas_favoritas_usuario'] LOOP
    IF to_regclass('public.' || item) IS NULL THEN
      RAISE EXCEPTION 'postcheck 064: índice % ausente', item;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
              WHERE t.relname LIKE 'whatsapp_atendimento_mensagens_prontas%' AND NOT c.convalidated) THEN
    RAISE EXCEPTION 'postcheck 064: restrição não validada';
  END IF;
  -- A 064 não altera a 060.
  IF to_regclass('public.whatsapp_atendimento_conversas') IS NULL OR to_regclass('public.whatsapp_atendimento_mensagens') IS NULL THEN
    RAISE EXCEPTION 'postcheck 064: tabelas da 060 ausentes';
  END IF;
END $$;
SELECT '064 postcheck OK' AS resultado;
