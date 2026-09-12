DO $$ BEGIN
IF EXISTS(SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename IN ('festas','festa_areas','festa_usuario_capacidades','festa_tarefas','festa_pendencias','festa_buffet','festa_contagens_convidados','festa_solicitacoes','festa_eventos')) THEN RAISE EXCEPTION '016: estruturas já existem'; END IF;
IF to_regclass('public.pagamento_eventos') IS NULL OR to_regclass('public.contrato_fluxos') IS NULL OR to_regclass('public.auditoria') IS NULL THEN RAISE EXCEPTION '016: pré-requisitos ausentes'; END IF;
IF (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND data_type='uuid' AND (table_name,column_name) IN (('contratos','id'),('contrato_versoes','id'),('contrato_fluxos','versao_vigente_id'),('usuarios_administrativos','id'),('contrato_pendencias_financeiras','id')))<>5 THEN RAISE EXCEPTION '016: tipos físicos incompatíveis'; END IF;
IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='auditoria'::regclass AND NOT tgisinternal AND (tgtype & 8)=8 AND (tgtype & 16)=16) THEN RAISE EXCEPTION '016: proteção de auditoria ausente'; END IF;
IF EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('fechamentos','fechamento_revisoes') AND column_name IN ('buffet_lembrancinha','buffet_empratado','buffet_bombom')) THEN RAISE EXCEPTION '016: escolhas já existem'; END IF;
END $$;
