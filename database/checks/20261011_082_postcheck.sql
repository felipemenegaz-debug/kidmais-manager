-- Postcheck da 082 (Wall-e): somente leitura. Os postchecks da 060, 080 e 081 continuam válidos com a 082 aplicada.
DO $$
DECLARE
  item text;
  col record;
BEGIN
  IF to_regclass('public.whatsapp_atendimento_arquivos') IS NULL THEN RAISE EXCEPTION 'postcheck 082: tabela de arquivos ausente'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.whatsapp_atendimento_arquivos'::regclass AND tgname = 'whatsapp_arquivos_controle' AND tgenabled = 'O') THEN
    RAISE EXCEPTION 'postcheck 082: trigger de controle dos arquivos (só revogação/troca de link) ausente ou desligado';
  END IF;
  IF to_regclass('public.whatsapp_atendimento_privacidade') IS NULL THEN RAISE EXCEPTION 'postcheck 082: registro de privacidade ausente'; END IF;
  FOREACH item IN ARRAY ARRAY['whatsapp_atendimento_controles_contato', 'whatsapp_atendimento_eventos_excluidos', 'whatsapp_atendimento_retencao_config', 'whatsapp_atendimento_retencao_execucoes'] LOOP
    IF to_regclass('public.' || item) IS NULL THEN RAISE EXCEPTION 'postcheck 082: tabela % ausente', item; END IF;
  END LOOP;
  IF to_regclass('public.whatsapp_retencao_uma_por_vez') IS NULL THEN RAISE EXCEPTION 'postcheck 082: índice de execução única da retenção ausente'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.whatsapp_atendimento_mensagens'::regclass AND conname = 'whatsapp_mensagens_motivo_cancelamento' AND convalidated) THEN
    RAISE EXCEPTION 'postcheck 082: motivo de cancelamento ausente';
  END IF;
  FOREACH item IN ARRAY ARRAY['whatsapp_privacidade_autor', 'whatsapp_privacidade_alvo', 'whatsapp_privacidade_retencao', 'whatsapp_privacidade_motivo'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.whatsapp_atendimento_privacidade'::regclass AND conname = item AND convalidated) THEN
      RAISE EXCEPTION 'postcheck 082: restrição % ausente ou não validada', item;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM whatsapp_atendimento_arquivos WHERE revogado_em IS NOT NULL AND octet_length(conteudo) <> 0) THEN
    RAISE EXCEPTION 'postcheck 082: arquivo revogado com conteúdo';
  END IF;
  FOREACH item IN ARRAY ARRAY['whatsapp_arquivos_mime_por_tipo', 'whatsapp_arquivos_tamanho', 'whatsapp_arquivos_hash', 'whatsapp_arquivos_token_uk', 'whatsapp_arquivos_escopo_uk', 'whatsapp_arquivos_revogacao', 'whatsapp_arquivos_expiracao'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.whatsapp_atendimento_arquivos'::regclass AND conname = item AND convalidated) THEN
      RAISE EXCEPTION 'postcheck 082: restrição % ausente ou não validada', item;
    END IF;
  END LOOP;
  FOREACH item IN ARRAY ARRAY['whatsapp_prontas_tipo', 'whatsapp_prontas_midia_por_tipo', 'whatsapp_prontas_legenda_limite', 'whatsapp_prontas_estado', 'whatsapp_prontas_estado_ativa',
                              'whatsapp_prontas_finalidade', 'whatsapp_prontas_automatico_finalidade', 'whatsapp_prontas_pacote_codigo', 'whatsapp_prontas_estabelecimento', 'whatsapp_prontas_arquivo'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.whatsapp_atendimento_mensagens_prontas'::regclass AND conname = item AND convalidated) THEN
      RAISE EXCEPTION 'postcheck 082: restrição % ausente ou não validada', item;
    END IF;
  END LOOP;
  FOREACH item IN ARRAY ARRAY['whatsapp_mensagens_ordem', 'whatsapp_mensagens_midia_nome', 'whatsapp_mensagens_fonte', 'whatsapp_mensagens_origem_grupo_uk', 'whatsapp_mensagens_origem_grupo',
                              'whatsapp_mensagens_midia_tipo', 'whatsapp_mensagens_midia_par', 'whatsapp_mensagens_legenda_limite', 'whatsapp_mensagens_midia_arquivo'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.whatsapp_atendimento_mensagens'::regclass AND conname = item AND convalidated) THEN
      RAISE EXCEPTION 'postcheck 082: restrição % ausente ou não validada', item;
    END IF;
  END LOOP;
  IF pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conrelid = 'public.whatsapp_atendimento_mensagens_prontas'::regclass AND conname = 'whatsapp_prontas_tipo')) NOT LIKE '%IMAGEM%VIDEO%DOCUMENTO%'
     OR pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conrelid = 'public.whatsapp_atendimento_mensagens'::regclass AND conname = 'whatsapp_mensagens_midia_tipo')) NOT LIKE '%IMAGEM%VIDEO%DOCUMENTO%' THEN
    RAISE EXCEPTION 'postcheck 082: listas de tipo sem DOCUMENTO';
  END IF;
  IF pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conrelid = 'public.whatsapp_atendimento_mensagens_prontas'::regclass AND conname = 'whatsapp_prontas_arquivo'))
       <> 'FOREIGN KEY (arquivo_id, empresa_id, ambiente, tipo) REFERENCES whatsapp_atendimento_arquivos(id, empresa_id, ambiente, tipo)'
     OR pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conrelid = 'public.whatsapp_atendimento_mensagens'::regclass AND conname = 'whatsapp_mensagens_midia_arquivo'))
       <> 'FOREIGN KEY (midia_arquivo_id, empresa_id, ambiente, midia_tipo) REFERENCES whatsapp_atendimento_arquivos(id, empresa_id, ambiente, tipo)' THEN
    RAISE EXCEPTION 'postcheck 082: FK de arquivo diferente (empresa, ambiente e tipo precisam fazer parte)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.whatsapp_atendimento_conversas'::regclass AND attname = 'contexto' AND attnotnull AND NOT attisdropped)
     OR NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.whatsapp_atendimento_conversas'::regclass AND attname = 'passagem' AND NOT attnotnull AND NOT attisdropped) THEN
    RAISE EXCEPTION 'postcheck 082: colunas de memória/passagem da conversa ausentes';
  END IF;
  -- A unicidade da 060 em origem_id continua (a primeira saída de cada entrada).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.whatsapp_atendimento_mensagens'::regclass AND contype = 'u' AND pg_get_constraintdef(oid) = 'UNIQUE (origem_id)') THEN
    RAISE EXCEPTION 'postcheck 082: unicidade da 060 em origem_id foi removida';
  END IF;
  IF EXISTS (SELECT 1 FROM whatsapp_atendimento_mensagens_prontas WHERE ativa <> (estado <> 'ARQUIVADA')) THEN
    RAISE EXCEPTION 'postcheck 082: estado das prontas incoerente com ativa';
  END IF;
  -- B2 (revisão de aa04387): colunas da retenção conferidas uma a uma (tipo, nulidade e default), não só a tabela. Uma
  -- 082 anterior (sem posse por arrendamento, contagens por empresa ou configuração alterada) é recusada aqui.
  FOR col IN SELECT * FROM (VALUES
      ('estado', 'text', true, NULL), ('recentes', 'integer', true, '0'), ('config_alterada', 'integer', true, '0'),
      ('posse_token', 'uuid', false, NULL), ('posse_ate', 'timestamp with time zone', false, NULL),
      ('por_empresa', 'jsonb', true, '''{}''::jsonb'), ('falhas', 'integer', true, '0'), ('erros', 'text[]', true, '''{}''::text[]')
    ) AS esperado(nome, tipo, obrigatoria, padrao) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE a.attrelid = 'public.whatsapp_atendimento_retencao_execucoes'::regclass AND a.attname = col.nome AND NOT a.attisdropped
          AND format_type(a.atttypid, a.atttypmod) = col.tipo AND a.attnotnull = col.obrigatoria
          AND (col.padrao IS NULL OR pg_get_expr(d.adbin, d.adrelid) = col.padrao)) THEN
      RAISE EXCEPTION 'postcheck 082: coluna %.% ausente ou diferente do esperado (%; obrigatória=%; padrão=%)', 'whatsapp_atendimento_retencao_execucoes', col.nome, col.tipo, col.obrigatoria, coalesce(col.padrao, '-');
    END IF;
  END LOOP;
  FOREACH item IN ARRAY ARRAY['INTERROMPIDA', 'jsonb_typeof(por_empresa)', 'config_alterada >= 0', 'recentes >= 0'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.whatsapp_atendimento_retencao_execucoes'::regclass AND contype = 'c' AND convalidated
        AND position(item IN pg_get_constraintdef(oid)) > 0) THEN
      RAISE EXCEPTION 'postcheck 082: restrição da execução da retenção com "%" ausente ou não validada', item;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indexrelid = 'public.whatsapp_retencao_uma_por_vez'::regclass AND i.indisunique AND i.indisvalid
      AND position('EM_ANDAMENTO' IN pg_get_expr(i.indpred, i.indrelid)) > 0) THEN
    RAISE EXCEPTION 'postcheck 082: índice de execução única da retenção não é único, válido e parcial (EM_ANDAMENTO)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.whatsapp_atendimento_mensagens'::regclass AND conname = 'whatsapp_mensagens_motivo_cancelamento'
      AND position('GRUPO_INCOMPLETO' IN pg_get_constraintdef(oid)) > 0) THEN
    RAISE EXCEPTION 'postcheck 082: motivo de cancelamento sem GRUPO_INCOMPLETO';
  END IF;
END $$;
SELECT '082 postcheck OK' AS resultado;
