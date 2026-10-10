-- Postcheck da 077b (fotos e vídeos; atalhos ampliados): somente leitura.
DO $$
DECLARE
  item text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.whatsapp_atendimento_mensagens_prontas'::regclass AND attname = 'midia_url' AND NOT attisdropped AND NOT attnotnull)
     OR NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.whatsapp_atendimento_mensagens'::regclass AND attname = 'midia_url' AND NOT attisdropped AND NOT attnotnull)
     OR NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.whatsapp_atendimento_mensagens'::regclass AND attname = 'midia_tipo' AND NOT attisdropped AND NOT attnotnull)
     OR NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.whatsapp_atendimento_mensagens'::regclass AND attname = 'midia_pronta_id' AND NOT attisdropped AND NOT attnotnull)
     OR NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.whatsapp_atendimento_mensagens'::regclass AND attname = 'midia_pronta_versao' AND NOT attisdropped AND NOT attnotnull) THEN
    RAISE EXCEPTION 'postcheck 077b: coluna anulável de mídia ausente';
  END IF;
  -- Origem da mídia: FK composta (id, empresa, ambiente) para a mensagem pronta, validada; é ela que impede o down da 077a.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.whatsapp_atendimento_mensagens'::regclass AND conname = 'whatsapp_mensagens_midia_pronta'
                  AND contype = 'f' AND convalidated AND confrelid = 'public.whatsapp_atendimento_mensagens_prontas'::regclass
                  AND pg_get_constraintdef(oid) = 'FOREIGN KEY (midia_pronta_id, empresa_id, ambiente) REFERENCES whatsapp_atendimento_mensagens_prontas(id, empresa_id, ambiente)') THEN
    RAISE EXCEPTION 'postcheck 077b: FK da origem da mídia ausente ou diferente';
  END IF;
  FOREACH item IN ARRAY ARRAY['whatsapp_prontas_tipo', 'whatsapp_prontas_atalho', 'whatsapp_prontas_midia_url_formato', 'whatsapp_prontas_midia_por_tipo', 'whatsapp_prontas_legenda_limite'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.whatsapp_atendimento_mensagens_prontas'::regclass AND conname = item AND contype = 'c' AND convalidated) THEN
      RAISE EXCEPTION 'postcheck 077b: restrição % ausente ou não validada', item;
    END IF;
  END LOOP;
  FOREACH item IN ARRAY ARRAY['whatsapp_mensagens_midia_tipo', 'whatsapp_mensagens_midia_url_formato', 'whatsapp_mensagens_midia_par', 'whatsapp_mensagens_midia_so_saida', 'whatsapp_mensagens_legenda_limite',
                              'whatsapp_mensagens_midia_pronta_versao', 'whatsapp_mensagens_midia_origem'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.whatsapp_atendimento_mensagens'::regclass AND conname = item AND contype = 'c' AND convalidated) THEN
      RAISE EXCEPTION 'postcheck 077b: restrição % ausente ou não validada', item;
    END IF;
  END LOOP;
  -- As restrições antigas da 077a saíram (substituídas pelas ampliadas).
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.whatsapp_atendimento_mensagens_prontas'::regclass
              AND conname IN ('whatsapp_atendimento_mensagens_prontas_tipo_check', 'whatsapp_atendimento_mensagens_prontas_atalho_check')) THEN
    RAISE EXCEPTION 'postcheck 077b: restrição antiga da 077a ainda presente';
  END IF;
  IF pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conrelid = 'public.whatsapp_atendimento_mensagens_prontas'::regclass AND conname = 'whatsapp_prontas_tipo')) NOT LIKE '%IMAGEM%VIDEO%'
     OR pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conrelid = 'public.whatsapp_atendimento_mensagens_prontas'::regclass AND conname = 'whatsapp_prontas_atalho')) NOT LIKE '%SALGADOS%BOLOS%ENDERECO%LOCALIZACAO%' THEN
    RAISE EXCEPTION 'postcheck 077b: listas de tipo/atalho sem os valores novos';
  END IF;
  -- A 077a e a 060 continuam: regra de link por tipo, atalho único por empresa e isolamento das mensagens.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.whatsapp_atendimento_mensagens_prontas'::regclass AND conname = 'whatsapp_prontas_link_por_tipo' AND convalidated)
     OR to_regclass('public.whatsapp_prontas_atalho_unico') IS NULL OR to_regclass('public.whatsapp_atendimento_conversas') IS NULL THEN
    RAISE EXCEPTION 'postcheck 077b: estrutura da 077a/060 afetada';
  END IF;
END $$;
SELECT '077b postcheck OK' AS resultado;
