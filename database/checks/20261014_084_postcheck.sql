-- Postcheck da 084 (automações de Marketing): somente leitura.
DO $$
DECLARE
  item text;
BEGIN
  FOREACH item IN ARRAY ARRAY['marketing_automacao_regras', 'marketing_automacao_execucoes', 'marketing_automacao_eventos', 'marketing_contato_preferencias',
                              'marketing_contato_preferencias_eventos', 'marketing_tarefas', 'marketing_transporte_simulado'] LOOP
    IF to_regclass('public.' || item) IS NULL THEN RAISE EXCEPTION 'postcheck 084: tabela % ausente', item; END IF;
  END LOOP;
  FOREACH item IN ARRAY ARRAY['marketing_regras_tipo_uk', 'marketing_exec_fila_idx', 'marketing_exec_provedor_uk'] LOOP
    IF to_regclass('public.' || item) IS NULL THEN RAISE EXCEPTION 'postcheck 084: índice % ausente', item; END IF;
  END LOOP;
  FOREACH item IN ARRAY ARRAY['marketing_exec_tenant', 'marketing_automacao_eventos_imutavel', 'marketing_pref_tenant', 'marketing_pref_eventos_imutavel'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = item AND tgenabled = 'O' AND NOT tgisinternal) THEN
      RAISE EXCEPTION 'postcheck 084: trigger % ausente ou desligado', item;
    END IF;
  END LOOP;
  FOREACH item IN ARRAY ARRAY['marketing_regras_mensagem_revisada', 'marketing_exec_chave_uk', 'marketing_exec_posse', 'marketing_exec_provedor',
                              'marketing_pref_autorizacao', 'marketing_pref_descadastro', 'marketing_tarefas_exec_uk', 'marketing_simulado_idempotencia_uk'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = item AND convalidated) THEN
      RAISE EXCEPTION 'postcheck 084: restrição % ausente ou não validada', item;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM marketing_automacao_regras WHERE status = 'ATIVA' AND acao = 'MENSAGEM_WHATSAPP' AND template_revisado_em IS NULL) THEN
    RAISE EXCEPTION 'postcheck 084: regra de mensagem ativa sem revisão';
  END IF;
END $$;
SELECT '084 postcheck OK' AS resultado;
