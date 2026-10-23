-- Somente leitura. Confirma o schema comercial (006, 029, 047) e que a 092 ainda não foi aplicada.
DO $$
BEGIN
  IF to_regclass('public.precos_pacote') IS NULL OR to_regclass('public.fechamento_pacote_snapshots') IS NULL
    OR to_regclass('public.tabela_preco_escopos') IS NULL
    OR to_regprocedure('public.kidmais_047_lacunas_escopo(uuid)') IS NULL THEN
    RAISE EXCEPTION '092 precheck: precos_pacote, fechamento_pacote_snapshots, tabela_preco_escopos ou kidmais_047_lacunas_escopo ausente';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'precos_pacote_tipo_calculo_check')
    OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fechamento_pacote_snapshots_tipo_check') THEN
    RAISE EXCEPTION '092 precheck: CHECK de tipo_calculo ausente';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'precos_pacote_092_ponto_check')
    OR EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'precos_pacote_tipo_calculo_check'
                AND pg_get_constraintdef(oid) LIKE '%PONTO%') THEN
    RAISE EXCEPTION '092 precheck: aplicação anterior ou parcial encontrada';
  END IF;
  RAISE NOTICE '092 precheck OK';
END $$;
-- Contagem informativa: linhas de preço por tipo nas tabelas correntes (sem ids).
SELECT pp.tipo_calculo, count(*) AS linhas
  FROM precos_pacote pp
  JOIN tabelas_preco t ON t.id = pp.tabela_preco_id
 WHERE pp.ativo AND t.publicada_em IS NOT NULL AND t.substituida_em IS NULL
 GROUP BY pp.tipo_calculo
 ORDER BY pp.tipo_calculo;
