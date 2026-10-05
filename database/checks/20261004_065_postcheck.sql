-- Postcheck da 065 (nome de perfil do WhatsApp na conversa): somente leitura.
DO $$
DECLARE
  item text;
BEGIN
  FOREACH item IN ARRAY ARRAY['nome_perfil', 'nome_perfil_em'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.whatsapp_atendimento_conversas'::regclass
                    AND attname = item AND NOT attisdropped AND NOT attnotnull) THEN
      RAISE EXCEPTION 'postcheck 065: coluna anulável % ausente', item;
    END IF;
  END LOOP;
  IF (SELECT format_type(atttypid, atttypmod) FROM pg_attribute WHERE attrelid = 'public.whatsapp_atendimento_conversas'::regclass AND attname = 'nome_perfil') <> 'text'
     OR (SELECT format_type(atttypid, atttypmod) FROM pg_attribute WHERE attrelid = 'public.whatsapp_atendimento_conversas'::regclass AND attname = 'nome_perfil_em') <> 'timestamp with time zone' THEN
    RAISE EXCEPTION 'postcheck 065: tipo de coluna divergente';
  END IF;
  FOREACH item IN ARRAY ARRAY['whatsapp_atendimento_conversas_nome_perfil_formato', 'whatsapp_atendimento_conversas_nome_perfil_par'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.whatsapp_atendimento_conversas'::regclass
                    AND conname = item AND contype = 'c' AND convalidated) THEN
      RAISE EXCEPTION 'postcheck 065: restrição % ausente ou não validada', item;
    END IF;
  END LOOP;
  -- O isolamento da 060 continua: unicidade por (empresa, ambiente, contato).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = 'public.whatsapp_atendimento_conversas'::regclass AND c.contype = 'u'
                   AND (SELECT array_agg(a.attname::text ORDER BY a.attname) FROM pg_attribute a WHERE a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)) = ARRAY['ambiente', 'contato', 'empresa_id']) THEN
    RAISE EXCEPTION 'postcheck 065: unicidade (empresa, ambiente, contato) da 060 ausente';
  END IF;
END $$;
SELECT '065 postcheck OK' AS resultado;
