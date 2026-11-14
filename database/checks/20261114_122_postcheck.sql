DO $$ BEGIN
 IF (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND ((table_name='marketing_contatos' AND column_name IN ('responsavel_id','perda_motivo','perda_observacao','perdida_em')) OR (table_name='fechamentos' AND column_name IN ('perda_motivo','perda_observacao','perdida_em','confirmada_em'))))<>8 THEN RAISE EXCEPTION '122: colunas divergentes'; END IF;
 IF to_regclass('public.oportunidades_acoes') IS NULL OR to_regclass('public.oportunidades_marcos') IS NULL OR to_regclass('public.oportunidades_resumos') IS NULL THEN RAISE EXCEPTION '122: tabelas ausentes'; END IF;
 IF (SELECT count(*) FROM pg_trigger WHERE tgname IN ('oportunidades_acoes_integridade','oportunidades_etapa','oportunidades_confirmada') AND tgenabled='O')<>3 THEN RAISE EXCEPTION '122: gatilhos divergentes'; END IF;
 IF (SELECT count(*) FROM pg_index WHERE indexrelid IN ('public.oportunidades_acao_contato_aberta'::regclass,'public.oportunidades_acao_fechamento_aberta'::regclass,'public.oportunidades_acoes_dia'::regclass) AND indisvalid AND indisready)<>3 THEN RAISE EXCEPTION '122: índices divergentes'; END IF;
 IF EXISTS(SELECT 1 FROM oportunidades_acoes a LEFT JOIN marketing_contatos k ON k.id=a.contato_id AND k.empresa_id=a.empresa_id LEFT JOIN fechamentos f ON f.id=a.fechamento_id AND f.empresa_id=a.empresa_id WHERE (a.contato_id IS NOT NULL AND k.id IS NULL) OR (a.fechamento_id IS NOT NULL AND f.id IS NULL)) THEN RAISE EXCEPTION '122: vínculo fora da empresa'; END IF;
END $$;
SELECT true AS aprovado;
