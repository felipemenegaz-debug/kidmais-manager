-- Somente leitura. Confirma 068/074a e que a 097 ainda não foi aplicada.
DO $$
BEGIN
  IF to_regclass('public.empresa_assinaturas') IS NULL OR to_regclass('public.usuarios_administrativos') IS NULL THEN
    RAISE EXCEPTION '097 precheck: 068 ou 074a ausente';
  END IF;
  IF to_regclass('public.assinatura_arrependimentos') IS NOT NULL OR to_regprocedure('public.kidmais_097_guarda()') IS NOT NULL THEN
    RAISE EXCEPTION '097 precheck: aplicação anterior ou parcial encontrada';
  END IF;
  RAISE NOTICE '097 precheck OK';
END $$;
SELECT count(*) AS assinaturas_existentes FROM empresa_assinaturas;
