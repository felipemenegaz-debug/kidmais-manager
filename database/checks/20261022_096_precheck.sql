-- Somente leitura. Confirma 069/074a e que a 096 ainda não foi aplicada.
DO $$
BEGIN
  IF to_regclass('public.assinatura_contratacoes') IS NULL OR to_regclass('public.usuarios_administrativos') IS NULL
    OR to_regclass('public.aceites_documentos_legais') IS NULL THEN
    RAISE EXCEPTION '096 precheck: 069 ou 074a ausente';
  END IF;
  IF to_regclass('public.documentos_legais_versoes') IS NOT NULL OR to_regclass('public.assinatura_comprovantes') IS NOT NULL
    OR to_regprocedure('public.kidmais_096_guarda()') IS NOT NULL THEN
    RAISE EXCEPTION '096 precheck: aplicação anterior ou parcial encontrada';
  END IF;
  RAISE NOTICE '096 precheck OK';
END $$;
-- Contagem informativa: ofertas existentes ficam sem comprovante (a 096 não cria comprovante retroativo).
SELECT count(*) AS ofertas_existentes FROM assinatura_contratacoes;
