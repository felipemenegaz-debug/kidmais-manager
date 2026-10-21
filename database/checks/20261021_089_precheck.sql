-- Somente leitura. Confirma o schema comercial (067, 068 e 074a) e que a 089 ainda não foi aplicada.
DO $$
BEGIN
  IF to_regclass('public.empresa_assinaturas') IS NULL OR to_regclass('public.cobranca_eventos') IS NULL
    OR to_regclass('public.assinatura_contratacoes') IS NULL OR to_regclass('public.usuarios_administrativos') IS NULL THEN
    RAISE EXCEPTION '089 precheck: empresa_assinaturas, cobranca_eventos, assinatura_contratacoes ou usuarios_administrativos ausente';
  END IF;
  IF to_regclass('public.assinatura_encerramentos') IS NOT NULL OR to_regclass('public.assinatura_encerramentos_cobranca_uk') IS NOT NULL
    OR to_regclass('public.assinatura_encerramentos_garantia_uk') IS NOT NULL OR to_regclass('public.assinatura_encerramentos_empresa_idx') IS NOT NULL
    OR to_regclass('public.assinatura_encerramentos_abertos_idx') IS NOT NULL OR to_regprocedure('public.kidmais_089_encerramento_guarda()') IS NOT NULL THEN
    RAISE EXCEPTION '089 precheck: aplicação anterior ou parcial encontrada';
  END IF;
  RAISE NOTICE '089 precheck OK';
END $$;
-- Contagem informativa (sem ids nem dados pessoais): assinaturas que passam a ver as opções de encerramento.
SELECT situacao, ciclo, count(*) AS assinaturas FROM empresa_assinaturas GROUP BY situacao, ciclo ORDER BY situacao, ciclo;
