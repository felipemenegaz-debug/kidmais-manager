-- Postcheck da 084 (automações de Marketing): somente leitura.
DO $$
DECLARE
  item text;
BEGIN
  FOREACH item IN ARRAY ARRAY['marketing_automacao_regras', 'marketing_automacao_execucoes', 'marketing_automacao_eventos', 'marketing_contato_preferencias',
                              'marketing_contato_preferencias_eventos', 'marketing_contato_autorizacoes', 'marketing_tarefas', 'marketing_transporte_simulado'] LOOP
    IF to_regclass('public.' || item) IS NULL THEN RAISE EXCEPTION 'postcheck 084: tabela % ausente', item; END IF;
  END LOOP;
  FOREACH item IN ARRAY ARRAY['marketing_regras_tipo_uk', 'marketing_exec_fila_idx', 'marketing_exec_provedor_uk', 'marketing_aut_viva_uk'] LOOP
    IF to_regclass('public.' || item) IS NULL THEN RAISE EXCEPTION 'postcheck 084: índice % ausente', item; END IF;
  END LOOP;
  FOREACH item IN ARRAY ARRAY['marketing_exec_tenant', 'marketing_automacao_eventos_imutavel', 'marketing_pref_tenant', 'marketing_pref_eventos_imutavel', 'marketing_aut_controle',
                              'marketing_aut_numero_saiu'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = item AND tgenabled = 'O' AND NOT tgisinternal) THEN
      RAISE EXCEPTION 'postcheck 084: trigger % ausente ou desligado', item;
    END IF;
  END LOOP;
  FOREACH item IN ARRAY ARRAY['marketing_regras_mensagem_revisada', 'marketing_exec_chave_uk', 'marketing_exec_posse', 'marketing_exec_provedor',
                              'marketing_aut_destino', 'marketing_aut_estado', 'marketing_aut_revogada', 'marketing_aut_formulario_tem_contato',
                              'marketing_aut_canal', 'marketing_aut_origem', 'marketing_aut_evidencia', 'marketing_aut_confirmada', 'marketing_aut_confirmacao',
                              'marketing_aut_motivo', 'marketing_aut_contato_fk', 'marketing_pref_descadastro', 'marketing_tarefas_exec_uk', 'marketing_simulado_idempotencia_uk'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = item AND convalidated) THEN
      RAISE EXCEPTION 'postcheck 084: restrição % ausente ou não validada', item;
    END IF;
  END LOOP;
  -- Versão vigente das regras de autorização (O1/O2 de 15/10/2026), e não uma 084 anterior aplicada por engano.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'marketing_aut_confirmada' AND pg_get_constraintdef(oid) LIKE '%confirmacao IS NULL%' AND pg_get_constraintdef(oid) LIKE '%confirmada_por IS NULL%')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'marketing_aut_revogada' AND pg_get_constraintdef(oid) LIKE '%revogada_por IS NULL%') THEN
    RAISE EXCEPTION 'postcheck 084: restrições de evidência da autorização desatualizadas';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'kidmais084_autorizacao_controle' AND prosrc LIKE '%evidências de confirmação da autorização são imutáveis%') THEN
    RAISE EXCEPTION 'postcheck 084: gatilho da autorização não congela as evidências de confirmação';
  END IF;
  IF to_regprocedure('public.kidmais084_numero_saiu_do_cadastro()') IS NULL
     OR kidmais084_destino('(11) 98888-7777') IS DISTINCT FROM '5511988887777' OR kidmais084_destino('5511988887777') IS DISTINCT FROM '5511988887777'
     OR kidmais084_destino('1133334444') IS DISTINCT FROM '551133334444' OR kidmais084_destino('123') IS NOT NULL OR kidmais084_destino(NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'postcheck 084: normalização de destino ou revogação por número fora do cadastro ausente';
  END IF;
  IF EXISTS (SELECT 1 FROM marketing_automacao_regras WHERE status = 'ATIVA' AND acao = 'MENSAGEM_WHATSAPP' AND template_revisado_em IS NULL) THEN
    RAISE EXCEPTION 'postcheck 084: regra de mensagem ativa sem revisão';
  END IF;
END $$;
SELECT '084 postcheck OK' AS resultado;
