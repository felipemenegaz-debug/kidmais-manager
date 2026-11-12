-- Somente leitura. Confirma 074a/075, a forma revisada de vaga da 074a e que a 090 ainda não foi aplicada.
DO $$
BEGIN
  IF to_regclass('public.assinatura_fundadores') IS NULL OR to_regclass('public.assinatura_contratacoes') IS NULL
    OR to_regclass('public.assinatura_renovacoes') IS NULL OR to_regclass('public.usuarios_administrativos') IS NULL
    OR to_regprocedure('public.kidmais_074_registro_guarda()') IS NULL THEN
    RAISE EXCEPTION '090 precheck: 074a ou 075 ausente';
  END IF;
  IF to_regclass('public.assinatura_campanhas') IS NOT NULL OR to_regprocedure('public.kidmais_090_campanha_guarda()') IS NOT NULL
    OR to_regprocedure('public.kidmais_090_fundador_guarda()') IS NOT NULL
    OR to_regclass('public.assinatura_fundadores_vaga_legado_uk') IS NOT NULL OR to_regclass('public.assinatura_fundadores_vaga_pos_uk') IS NOT NULL
    OR EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'assinatura_fundadores'
               AND column_name IN ('campanha_id','origem','regra_versao','oferta_valida_ate')) THEN
    RAISE EXCEPTION '090 precheck: aplicação anterior ou parcial encontrada';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.assinatura_fundadores'::regclass
                 AND conname = 'assinatura_fundadores_vaga_check' AND contype = 'c')
    OR to_regclass('public.assinatura_fundadores_vaga_uk') IS NULL THEN
    RAISE EXCEPTION '090 precheck: CHECK ou índice de vaga da 074a divergiu';
  END IF;
  -- Linhas que o backfill LEGADO recusaria (não deve haver: a 074a já exige vaga 1–20).
  IF EXISTS (SELECT 1 FROM assinatura_fundadores WHERE vaga IS NULL OR vaga NOT BETWEEN 1 AND 20) THEN
    RAISE EXCEPTION '090 precheck: vaga fora de 1–20 encontrada; reconciliar antes';
  END IF;
  RAISE NOTICE '090 precheck OK';
END $$;
-- Contagem informativa (sem ids nem documentos): concessões existentes que viram LEGADO.
SELECT estado, count(*) AS fundadores FROM assinatura_fundadores GROUP BY estado ORDER BY estado;
