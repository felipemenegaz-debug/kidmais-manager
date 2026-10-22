-- Somente leitura. Confirma 067/068/069/074a, os CHECKs revisados e que a 091 ainda não foi aplicada.
DO $$
BEGIN
  IF to_regclass('public.empresa_assinaturas') IS NULL OR to_regclass('public.assinatura_fundadores') IS NULL
    OR to_regclass('public.cadastros_empresas') IS NULL OR to_regclass('public.solicitacoes_acesso_empresa') IS NULL
    OR to_regclass('public.empresa_representacoes') IS NULL THEN
    RAISE EXCEPTION '091 precheck: 067, 068, 069 ou 074a ausente';
  END IF;
  IF to_regprocedure('public.kidmais_091_documento_valido(text)') IS NOT NULL OR to_regprocedure('public.kidmais_091_documento_guarda()') IS NOT NULL
    OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgname IN ('empresa_assinaturas_091_documento','assinatura_fundadores_091_documento')) THEN
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
-- Informativo (sem documentos): linhas antigas com DV de CNPJ inválido. A 091 NÃO as revalida nem trava (DV só no INSERT);
-- só ficam registradas para revisão. Cálculo do DV oficial igual ao da migration, sem criar função.
WITH d AS (
  SELECT 'empresa_assinaturas' AS tabela, documento_teste AS doc FROM empresa_assinaturas WHERE documento_teste IS NOT NULL
  UNION ALL SELECT 'assinatura_fundadores', documento_beneficiario FROM assinatura_fundadores
), p AS (
  SELECT tabela, doc,
    (SELECT sum((ascii(substr(doc, i, 1)) - 48) * (ARRAY[5,4,3,2,9,8,7,6,5,4,3,2])[i]) FROM generate_series(1, 12) i) AS s1
  FROM d WHERE doc ~ '^[0-9A-Z]{12}[0-9]{2}$'
), q AS (
  SELECT tabela, doc, CASE WHEN s1 % 11 < 2 THEN 0 ELSE 11 - s1 % 11 END AS d1 FROM p
), r AS (
  SELECT tabela, doc, d1, CASE WHEN s2 % 11 < 2 THEN 0 ELSE 11 - s2 % 11 END AS d2
  FROM (SELECT tabela, doc, d1, (SELECT sum((ascii(substr(doc, i, 1)) - 48) * (ARRAY[6,5,4,3,2,9,8,7,6,5,4,3])[i]) FROM generate_series(1, 12) i) + d1 * 2 AS s2 FROM q) x
)
SELECT tabela, count(*) FILTER (WHERE d1 <> ascii(substr(doc, 13, 1)) - 48 OR d2 <> ascii(substr(doc, 14, 1)) - 48) AS cnpj_dv_invalido, count(*) AS cnpj_total
FROM r GROUP BY tabela ORDER BY tabela;
