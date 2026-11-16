-- Postcheck da 110 (pesquisa de satisfação): somente leitura; qualquer divergência interrompe.
DO $$
DECLARE
  item text;
  corpo text;
BEGIN
  FOREACH item IN ARRAY ARRAY['satisfacao_envios', 'satisfacao_respostas', 'satisfacao_tarefas', 'satisfacao_entregas', 'satisfacao_saidas',
                              'satisfacao_capacidades', 'satisfacao_agregados_mensais', 'satisfacao_expurgos', 'satisfacao_email_simulado'] LOOP
    IF to_regclass('public.' || item) IS NULL THEN RAISE EXCEPTION 'postcheck 110: tabela % ausente', item; END IF;
  END LOOP;
  FOREACH item IN ARRAY ARRAY['satisfacao_entregas_provedor_uk', 'satisfacao_capacidades_vigente_uk', 'satisfacao_agregados_uk', 'satisfacao_expurgos_uk'] LOOP
    IF to_regclass('public.' || item) IS NULL THEN RAISE EXCEPTION 'postcheck 110: índice % ausente', item; END IF;
  END LOOP;
  FOREACH item IN ARRAY ARRAY['satisfacao_envios_guarda', 'satisfacao_respostas_guarda', 'satisfacao_respostas_invariante', 'satisfacao_envios_invariante',
                              'satisfacao_tarefas_guarda', 'satisfacao_entregas_guarda', 'satisfacao_entregas_marco', 'satisfacao_capacidades_guarda'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = item AND tgenabled = 'O') THEN
      RAISE EXCEPTION 'postcheck 110: gatilho % ausente ou desligado', item;
    END IF;
  END LOOP;
  -- L1: as invariáveis são adiadas para o COMMIT.
  IF (SELECT count(*) FROM pg_trigger WHERE tgname IN ('satisfacao_respostas_invariante', 'satisfacao_envios_invariante') AND tgdeferrable AND tginitdeferred) <> 2 THEN
    RAISE EXCEPTION 'postcheck 110: invariáveis resposta ⇔ envio não são DEFERRABLE INITIALLY DEFERRED';
  END IF;
  FOREACH item IN ARRAY ARRAY['marketing_regras_acao', 'marketing_regras_pesquisa_pos_festa', 'marketing_regras_canais', 'marketing_regras_pesquisa_revisada',
                              'marketing_regras_template_lembrete', 'marketing_regras_template_lembrete_provedor',
                              'marketing_exec_acao', 'marketing_exec_estado', 'marketing_exec_final', 'marketing_exec_pesquisa_estados', 'marketing_exec_pesquisa_criada',
                              'satisfacao_envios_festa_uk', 'satisfacao_envios_token_uk', 'satisfacao_envios_escopo_uk', 'satisfacao_envios_execucao_uk',
                              'satisfacao_envios_fechamento_fk', 'satisfacao_envios_cliente_fk', 'satisfacao_envios_unidade_fk', 'satisfacao_envios_execucao_fk',
                              'satisfacao_envios_estado', 'satisfacao_envios_validade', 'satisfacao_envios_respondido', 'satisfacao_envios_revogado',
                              'satisfacao_envios_expirado', 'satisfacao_envios_hash',
                              'satisfacao_respostas_envio_uk', 'satisfacao_respostas_envio_fk', 'satisfacao_respostas_nps', 'satisfacao_respostas_aspectos',
                              'satisfacao_respostas_comentario', 'satisfacao_respostas_versao',
                              'satisfacao_tarefas_resposta_uk', 'satisfacao_tarefas_resposta_fk', 'satisfacao_tarefas_envio_fk',
                              'satisfacao_entregas_uk', 'satisfacao_entregas_posse', 'satisfacao_entregas_provedor', 'satisfacao_entregas_final',
                              'satisfacao_saidas_uk', 'satisfacao_capacidades_vinculo_fk'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = item AND convalidated) THEN
      RAISE EXCEPTION 'postcheck 110: restrição % ausente ou não validada', item;
    END IF;
  END LOOP;
  -- M4: FKs simples do envio para fechamento e cliente, com RESTRICT nas duas ações.
  IF (SELECT count(*) FROM pg_constraint WHERE conname IN ('satisfacao_envios_fechamento_fk', 'satisfacao_envios_cliente_fk')
        AND contype = 'f' AND confupdtype = 'r' AND confdeltype = 'r' AND cardinality(conkey) = 1) <> 2 THEN
    RAISE EXCEPTION 'postcheck 110: FK simples para fechamento/cliente sem RESTRICT';
  END IF;
  -- M4: 054 continua de pé (a coerência de tenant feita na criação depende da empresa imutável dos pais).
  IF (SELECT count(*) FROM pg_trigger t WHERE t.tgname IN ('clientes_054_empresa_imutavel_trg', 'fechamentos_054_empresa_imutavel_trg')
        AND t.tgenabled = 'O' AND t.tgfoid = 'public.kidmais_054_empresa_imutavel()'::regprocedure) <> 2 THEN
    RAISE EXCEPTION 'postcheck 110: gatilhos da 054 ausentes ou desligados';
  END IF;
  -- D-PS8: guard da 043 com a atualização de atualizado_em em todo UPDATE.
  IF position('NEW.atualizado_em := clock_timestamp()' IN pg_get_functiondef('public.kidmais_043_guard_membership_estabelecimentos()'::regprocedure)) = 0
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'kidmais_043_me_guard_trg' AND tgenabled = 'O') THEN
    RAISE EXCEPTION 'postcheck 110: guard da 043 sem a atualização de atualizado_em';
  END IF;
  -- N4: PESQUISA_CRIADA na lista de estados concluídos do gatilho da 086.
  corpo := pg_get_functiondef('public.kidmais086_execucao_tenant()'::regprocedure);
  IF position($q$OLD.estado IN ('TAREFA_CRIADA', 'PESQUISA_CRIADA', 'ENTREGUE', 'SUPRIMIDA', 'CANCELADA')$q$ IN corpo) = 0 THEN
    RAISE EXCEPTION 'postcheck 110: kidmais086_execucao_tenant sem PESQUISA_CRIADA';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'marketing_exec_tenant' AND tgenabled = 'O') THEN
    RAISE EXCEPTION 'postcheck 110: gatilho marketing_exec_tenant ausente ou desligado';
  END IF;
END $$;
