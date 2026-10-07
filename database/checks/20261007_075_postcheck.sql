-- Postcheck da 075 (Wall-e): somente leitura. Os postchecks da 060, 073 e 074 continuam válidos com a 075 aplicada.
DO $$
DECLARE
  item text;
BEGIN
  IF to_regclass('public.whatsapp_atendimento_arquivos') IS NULL THEN RAISE EXCEPTION 'postcheck 075: tabela de arquivos ausente'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.whatsapp_atendimento_arquivos'::regclass AND tgname = 'whatsapp_arquivos_imutavel' AND tgenabled = 'O') THEN
    RAISE EXCEPTION 'postcheck 075: trigger de imutabilidade dos arquivos ausente ou desligado';
  END IF;
  FOREACH item IN ARRAY ARRAY['whatsapp_arquivos_mime_por_tipo', 'whatsapp_arquivos_tamanho', 'whatsapp_arquivos_hash', 'whatsapp_arquivos_token_uk', 'whatsapp_arquivos_escopo_uk'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.whatsapp_atendimento_arquivos'::regclass AND conname = item AND convalidated) THEN
      RAISE EXCEPTION 'postcheck 075: restrição % ausente ou não validada', item;
    END IF;
  END LOOP;
  FOREACH item IN ARRAY ARRAY['whatsapp_prontas_tipo', 'whatsapp_prontas_midia_por_tipo', 'whatsapp_prontas_legenda_limite', 'whatsapp_prontas_estado', 'whatsapp_prontas_estado_ativa',
                              'whatsapp_prontas_finalidade', 'whatsapp_prontas_automatico_finalidade', 'whatsapp_prontas_pacote_codigo', 'whatsapp_prontas_estabelecimento', 'whatsapp_prontas_arquivo'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.whatsapp_atendimento_mensagens_prontas'::regclass AND conname = item AND convalidated) THEN
      RAISE EXCEPTION 'postcheck 075: restrição % ausente ou não validada', item;
    END IF;
  END LOOP;
  FOREACH item IN ARRAY ARRAY['whatsapp_mensagens_ordem', 'whatsapp_mensagens_midia_nome', 'whatsapp_mensagens_fonte', 'whatsapp_mensagens_origem_grupo_uk', 'whatsapp_mensagens_origem_grupo',
                              'whatsapp_mensagens_midia_tipo', 'whatsapp_mensagens_midia_par', 'whatsapp_mensagens_legenda_limite', 'whatsapp_mensagens_midia_arquivo'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.whatsapp_atendimento_mensagens'::regclass AND conname = item AND convalidated) THEN
      RAISE EXCEPTION 'postcheck 075: restrição % ausente ou não validada', item;
    END IF;
  END LOOP;
  IF pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conrelid = 'public.whatsapp_atendimento_mensagens_prontas'::regclass AND conname = 'whatsapp_prontas_tipo')) NOT LIKE '%IMAGEM%VIDEO%DOCUMENTO%'
     OR pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conrelid = 'public.whatsapp_atendimento_mensagens'::regclass AND conname = 'whatsapp_mensagens_midia_tipo')) NOT LIKE '%IMAGEM%VIDEO%DOCUMENTO%' THEN
    RAISE EXCEPTION 'postcheck 075: listas de tipo sem DOCUMENTO';
  END IF;
  IF pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conrelid = 'public.whatsapp_atendimento_mensagens_prontas'::regclass AND conname = 'whatsapp_prontas_arquivo'))
       <> 'FOREIGN KEY (arquivo_id, empresa_id, ambiente, tipo) REFERENCES whatsapp_atendimento_arquivos(id, empresa_id, ambiente, tipo)'
     OR pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conrelid = 'public.whatsapp_atendimento_mensagens'::regclass AND conname = 'whatsapp_mensagens_midia_arquivo'))
       <> 'FOREIGN KEY (midia_arquivo_id, empresa_id, ambiente, midia_tipo) REFERENCES whatsapp_atendimento_arquivos(id, empresa_id, ambiente, tipo)' THEN
    RAISE EXCEPTION 'postcheck 075: FK de arquivo diferente (empresa, ambiente e tipo precisam fazer parte)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.whatsapp_atendimento_conversas'::regclass AND attname = 'contexto' AND attnotnull AND NOT attisdropped)
     OR NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.whatsapp_atendimento_conversas'::regclass AND attname = 'passagem' AND NOT attnotnull AND NOT attisdropped) THEN
    RAISE EXCEPTION 'postcheck 075: colunas de memória/passagem da conversa ausentes';
  END IF;
  -- A unicidade da 060 em origem_id continua (a primeira saída de cada entrada).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.whatsapp_atendimento_mensagens'::regclass AND contype = 'u' AND pg_get_constraintdef(oid) = 'UNIQUE (origem_id)') THEN
    RAISE EXCEPTION 'postcheck 075: unicidade da 060 em origem_id foi removida';
  END IF;
  IF EXISTS (SELECT 1 FROM whatsapp_atendimento_mensagens_prontas WHERE ativa <> (estado <> 'ARQUIVADA')) THEN
    RAISE EXCEPTION 'postcheck 075: estado das prontas incoerente com ativa';
  END IF;
END $$;
SELECT '075 postcheck OK' AS resultado;
