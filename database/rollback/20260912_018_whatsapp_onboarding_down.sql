BEGIN;

DO $$
DECLARE
    conexao_existe boolean := to_regclass('public.whatsapp_conexoes') IS NOT NULL;
    tentativa_existe boolean := to_regclass('public.whatsapp_onboarding_tentativas') IS NOT NULL;
BEGIN
    IF conexao_existe IS DISTINCT FROM tentativa_existe THEN
        RAISE EXCEPTION 'Rollback 018: instalação parcial encontrada; operação recusada.';
    END IF;
    IF conexao_existe AND (
        EXISTS (SELECT 1 FROM public.whatsapp_conexoes)
        OR EXISTS (SELECT 1 FROM public.whatsapp_onboarding_tentativas)
    ) THEN
        RAISE EXCEPTION 'Rollback 018 recusado: existem dados de onboarding ou conexão WhatsApp.';
    END IF;
END $$;

DROP TABLE IF EXISTS public.whatsapp_onboarding_tentativas;
DROP TABLE IF EXISTS public.whatsapp_conexoes;
DROP FUNCTION IF EXISTS public.kidmais_whatsapp_tentativa_proteger();
DROP FUNCTION IF EXISTS public.kidmais_whatsapp_conexao_proteger();

COMMIT;
