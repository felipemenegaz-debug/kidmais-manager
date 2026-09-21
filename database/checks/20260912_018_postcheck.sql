DO $$
DECLARE
    colunas_conexao integer;
    colunas_tentativa integer;
BEGIN
    IF to_regclass('public.whatsapp_conexoes') IS NULL OR to_regclass('public.whatsapp_onboarding_tentativas') IS NULL THEN
        RAISE EXCEPTION 'Postcheck 018: tabelas ausentes.';
    END IF;
    SELECT count(*) INTO colunas_conexao FROM information_schema.columns WHERE table_schema='public' AND table_name='whatsapp_conexoes';
    SELECT count(*) INTO colunas_tentativa FROM information_schema.columns WHERE table_schema='public' AND table_name='whatsapp_onboarding_tentativas';
    IF colunas_conexao <> 26 OR colunas_tentativa <> 15 THEN
        RAISE EXCEPTION 'Postcheck 018: quantidade de colunas divergente (%/%).', colunas_conexao, colunas_tentativa;
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name IN ('whatsapp_conexoes','whatsapp_onboarding_tentativas')
          AND column_name IN ('access_token','authorization_code','token','codigo_autorizacao')
    ) THEN
        RAISE EXCEPTION 'Postcheck 018: coluna sensível em texto encontrada.';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='whatsapp_conexoes_ambiente_configurada_uk' AND indexdef LIKE '%WHERE (status = ''CONFIGURADA''::text)%')
       OR NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='whatsapp_tentativas_usuario_iniciada_uk')
       OR NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='whatsapp_tentativas_state_hash_uk') THEN
        RAISE EXCEPTION 'Postcheck 018: índices de unicidade ausentes ou divergentes.';
    END IF;
    IF to_regprocedure('public.kidmais_whatsapp_conexao_proteger()') IS NULL
       OR to_regprocedure('public.kidmais_whatsapp_tentativa_proteger()') IS NULL
       OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='whatsapp_conexoes_proteger_trg' AND tgrelid='public.whatsapp_conexoes'::regclass AND NOT tgisinternal)
       OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='whatsapp_tentativas_proteger_trg' AND tgrelid='public.whatsapp_onboarding_tentativas'::regclass AND NOT tgisinternal) THEN
        RAISE EXCEPTION 'Postcheck 018: proteções de imutabilidade ausentes.';
    END IF;
END $$;
