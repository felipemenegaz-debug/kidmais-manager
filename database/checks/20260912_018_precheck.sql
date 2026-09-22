DO $$
DECLARE
    conexao_existe boolean := to_regclass('public.whatsapp_conexoes') IS NOT NULL;
    tentativa_existe boolean := to_regclass('public.whatsapp_onboarding_tentativas') IS NOT NULL;
BEGIN
    IF to_regclass('public.usuarios_administrativos') IS NULL OR to_regclass('public.auditoria') IS NULL THEN
        RAISE EXCEPTION 'Precheck 018: estruturas administrativas obrigatórias ausentes.';
    END IF;
    IF conexao_existe IS DISTINCT FROM tentativa_existe THEN
        RAISE EXCEPTION 'Precheck 018: instalação parcial encontrada.';
    END IF;
    IF NOT conexao_existe AND (
        to_regprocedure('public.kidmais_whatsapp_conexao_proteger()') IS NOT NULL
        OR to_regprocedure('public.kidmais_whatsapp_tentativa_proteger()') IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'Precheck 018: funções conflitantes encontradas.';
    END IF;
END $$;
