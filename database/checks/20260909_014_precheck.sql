DO $$ BEGIN
 IF (SELECT count(*) FROM pg_tables WHERE schemaname='public')<>38 OR to_regclass('public.fechamento_revisoes') IS NOT NULL OR to_regclass('public.fechamento_revisao_adicionais') IS NOT NULL THEN RAISE EXCEPTION 'Precheck 014: estado físico inesperado'; END IF;
 IF to_regclass('public.contrato_assinaturas') IS NULL OR to_regclass('public.contrato_versoes_em_preparacao_uk') IS NULL OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='fechamentos_condicao_pagamento_check') THEN RAISE EXCEPTION 'Precheck 014: 012/013 ausente'; END IF;
 IF EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='contrato_assinaturas'::regclass AND confrelid='sessoes_administrativas'::regclass) THEN RAISE EXCEPTION 'Precheck 014: prova presa à sessão'; END IF;
END $$;
