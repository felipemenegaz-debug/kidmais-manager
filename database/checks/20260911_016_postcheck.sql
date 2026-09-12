DO $$ DECLARE t text; BEGIN
FOREACH t IN ARRAY ARRAY['festas','festa_areas','festa_usuario_capacidades','festa_tarefas','festa_pendencias','festa_buffet','festa_contagens_convidados','festa_solicitacoes','festa_eventos'] LOOP
IF to_regclass('public.'||t) IS NULL THEN RAISE EXCEPTION '016: tabela ausente %',t; END IF;
END LOOP;
IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='festa_contagens_imutavel') OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='festa_contagens_convidados'::regclass AND contype='u' AND pg_get_constraintdef(oid)='UNIQUE (corrige_contagem_id)') THEN RAISE EXCEPTION '016: proteção de contagens ausente'; END IF;
IF (SELECT count(*) FROM information_schema.columns WHERE table_name='festas' AND table_schema='public' AND column_name IN ('invalidada_em','invalidada_por','motivo_invalidacao'))<>3 THEN RAISE EXCEPTION '016: invalidação ausente'; END IF;
IF NOT EXISTS(SELECT 1 FROM pg_index WHERE indexrelid='festas_contrato_ativo_uk'::regclass AND indisunique AND pg_get_expr(indpred,indrelid)='(invalidada_em IS NULL)') THEN RAISE EXCEPTION '016: unicidade ativa ausente'; END IF;
IF EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='festas'::regclass AND contype='u' AND pg_get_constraintdef(oid)='UNIQUE (contrato_id)') THEN RAISE EXCEPTION '016: unicidade absoluta indevida'; END IF;
IF EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND ((table_name='festas' AND column_name IN ('status','contagem_final_id','versao_contratual_revisada_id')) OR (table_name IN ('festa_tarefas','festa_pendencias') AND column_name='etapa') OR (table_name='festa_solicitacoes' AND column_name IN ('decisao_operacional','estado_execucao','decisor_id','decidido_em','motivo_decisao')))) THEN RAISE EXCEPTION '016: ciclo operacional obsoleto'; END IF;
IF EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='festa_usuario_capacidades'::regclass AND pg_get_constraintdef(oid) ~ 'FESTA_(ENCERRAR|CONCLUIR|AUTORIZAR_EXCECAO|REABRIR|CONFIRMAR_CONTAGEM_FINAL|DECIDIR_SOLICITACAO)') THEN RAISE EXCEPTION '016: capacidades obsoletas'; END IF;
IF to_regclass('public.festa_ocorrencias') IS NOT NULL THEN RAISE EXCEPTION '016: ocorrências obsoletas'; END IF;
IF (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('fechamentos','fechamento_revisoes') AND column_name IN ('buffet_lembrancinha','buffet_empratado','buffet_bombom') AND data_type='text' AND is_nullable='YES' AND column_default IS NULL)<>6 THEN RAISE EXCEPTION '016: escolhas ausentes'; END IF;
END $$;
