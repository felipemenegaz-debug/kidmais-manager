DO $$ BEGIN
 IF to_regclass('public.marketing_contatos') IS NULL OR to_regclass('public.memberships') IS NULL OR to_regclass('public.fechamentos') IS NULL THEN RAISE EXCEPTION '122: dependências ausentes'; END IF;
 IF to_regclass('public.oportunidades_acoes') IS NOT NULL OR to_regclass('public.oportunidades_marcos') IS NOT NULL OR to_regclass('public.oportunidades_resumos') IS NOT NULL
 OR EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('marketing_contatos','fechamentos') AND column_name IN ('perda_motivo','perdida_em','confirmada_em'))
 THEN RAISE EXCEPTION '122 já presente ou parcial: conferir postcheck'; END IF;
END $$;
SELECT true AS aprovado;
