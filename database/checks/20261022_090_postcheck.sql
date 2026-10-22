-- Somente leitura: estrutura da 090, backfill LEGADO integral e campanhas coerentes com suas concessões.
DO $$
DECLARE colunas text[];
BEGIN
  SELECT array_agg(column_name::text ORDER BY column_name) INTO colunas FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'assinatura_campanhas';
  IF colunas IS DISTINCT FROM ARRAY['abertura_data','ativada_em','ativada_por','autorizacao','beneficio_meses','codigo','contagem','criada_em',
      'desconto_percentual','elegibilidade','encerrada_em','estado','fuso','id','inicio','janela_dias','janela_fim','motivo_encerramento',
      'vagas_pos_janela','validade_oferta','versao_regra']::text[] THEN
    RAISE EXCEPTION '090 postcheck: colunas ausentes ou inesperadas em assinatura_campanhas';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'assinatura_fundadores'
      AND column_name IN ('campanha_id','origem','regra_versao','oferta_valida_ate')) <> 4
    OR (SELECT is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'assinatura_fundadores' AND column_name = 'vaga') <> 'YES'
    OR (SELECT is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'assinatura_fundadores' AND column_name = 'origem') <> 'NO'
    OR (SELECT column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'assinatura_fundadores' AND column_name = 'origem') IS NOT NULL THEN
    RAISE EXCEPTION '090 postcheck: colunas de assinatura_fundadores divergentes';
  END IF;
  IF (SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.assinatura_fundadores'::regclass AND contype = 'c' AND convalidated
      AND conname IN ('assinatura_fundadores_vaga_check','assinatura_fundadores_campanha_check','assinatura_fundadores_origem_check')) <> 3
    OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.assinatura_campanhas'::regclass AND conname = 'assinatura_campanhas_ativacao_check' AND convalidated)
    OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.assinatura_fundadores'::regclass AND contype = 'f' AND confrelid = 'public.assinatura_campanhas'::regclass) THEN
    RAISE EXCEPTION '090 postcheck: constraints ausentes';
  END IF;
  IF to_regclass('public.assinatura_fundadores_vaga_uk') IS NOT NULL
    OR NOT EXISTS (SELECT 1 FROM pg_index WHERE indexrelid = 'public.assinatura_fundadores_vaga_legado_uk'::regclass AND indisvalid AND indisunique)
    OR NOT EXISTS (SELECT 1 FROM pg_index WHERE indexrelid = 'public.assinatura_fundadores_vaga_pos_uk'::regclass AND indisvalid AND indisunique)
    OR NOT EXISTS (SELECT 1 FROM pg_index WHERE indexrelid = 'public.assinatura_campanhas_ativa_uk'::regclass AND indisvalid AND indisunique)
    OR NOT EXISTS (SELECT 1 FROM pg_index WHERE indexrelid = 'public.assinatura_fundadores_campanha_idx'::regclass AND indisvalid)
    OR NOT EXISTS (SELECT 1 FROM pg_index WHERE indexrelid = 'public.assinatura_fundadores_empresa_uk'::regclass AND indisvalid AND indisunique)
    OR NOT EXISTS (SELECT 1 FROM pg_index WHERE indexrelid = 'public.assinatura_fundadores_documento_uk'::regclass AND indisvalid AND indisunique) THEN
    RAISE EXCEPTION '090 postcheck: índices ausentes ou inválidos';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled = 'O' AND (
        (tgrelid = 'public.assinatura_campanhas'::regclass AND tgname IN ('assinatura_campanhas_090_guarda','assinatura_campanhas_090_truncate'))
        OR (tgrelid = 'public.assinatura_fundadores'::regclass
            AND tgname IN ('assinatura_fundadores_090_campanha','assinatura_fundadores_074_guarda','assinatura_fundadores_074_truncate')))) <> 5 THEN
    RAISE EXCEPTION '090 postcheck: gatilhos ausentes';
  END IF;
  IF EXISTS (SELECT 1 FROM assinatura_fundadores f WHERE f.origem <> 'LEGADO'
             AND NOT EXISTS (SELECT 1 FROM assinatura_campanhas c WHERE c.id = f.campanha_id AND c.estado <> 'RASCUNHO')) THEN
    RAISE EXCEPTION '090 postcheck: concessão da campanha sem campanha ativada';
  END IF;
  -- Decisões D1–D3 de 22/10/2026 gravadas no schema.
  IF pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conrelid = 'public.assinatura_campanhas'::regclass AND conname = 'assinatura_campanhas_elegibilidade_check')) NOT LIKE '%OFERTA_PERSISTIDA%'
    OR pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conrelid = 'public.assinatura_campanhas'::regclass AND conname = 'assinatura_campanhas_validade_oferta_check')) NOT LIKE '%7 days%' THEN
    RAISE EXCEPTION '090 postcheck: regra aprovada (D1/D3) ausente no schema';
  END IF;
  RAISE NOTICE '090 postcheck OK';
END $$;
-- Contagem informativa (sem ids nem documentos).
SELECT origem, estado, count(*) AS fundadores FROM assinatura_fundadores GROUP BY origem, estado ORDER BY origem, estado;
SELECT estado, count(*) AS campanhas FROM assinatura_campanhas GROUP BY estado ORDER BY estado;
