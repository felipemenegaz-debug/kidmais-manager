-- Somente leitura. Confirma 067/068/069/074a, os CHECKs revisados e que a 091 ainda não foi aplicada.
DO $$
BEGIN
  IF to_regclass('public.empresa_assinaturas') IS NULL OR to_regclass('public.assinatura_fundadores') IS NULL
    OR to_regclass('public.cadastros_empresas') IS NULL OR to_regclass('public.solicitacoes_acesso_empresa') IS NULL
    OR to_regclass('public.empresa_representacoes') IS NULL THEN
    RAISE EXCEPTION '091 precheck: 067, 068, 069 ou 074a ausente';
  END IF;
  IF to_regprocedure('public.kidmais_091_documento_valido(text)') IS NOT NULL
    OR EXISTS (SELECT 1 FROM pg_constraint WHERE conname IN ('empresa_assinaturas_documento_teste_dv_check','assinatura_fundadores_documento_dv_check')) THEN
    RAISE EXCEPTION '091 precheck: aplicação anterior ou parcial encontrada';
  END IF;
  IF (SELECT count(*) FROM pg_constraint WHERE contype = 'c' AND conname IN ('empresa_assinaturas_documento_teste_check',
        'assinatura_fundadores_documento_beneficiario_check','cadastros_empresas_documento_check','solicitacoes_documento_check',
        'empresa_representacoes_qualificacao_check')) <> 5 THEN
    RAISE EXCEPTION '091 precheck: CHECKs de documento ou qualificação divergiram';
  END IF;
  RAISE NOTICE '091 precheck OK';
END $$;
-- Contagem informativa (sem documentos): linhas que a 091 NÃO altera nem revalida.
SELECT 'empresa_assinaturas' AS tabela, count(documento_teste) AS com_documento FROM empresa_assinaturas
UNION ALL SELECT 'assinatura_fundadores', count(*) FROM assinatura_fundadores
UNION ALL SELECT 'cadastros_empresas', count(*) FROM cadastros_empresas;
