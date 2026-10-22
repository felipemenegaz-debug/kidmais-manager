-- Somente leitura: as onze tabelas da 095, constraints de saldo/idempotência, índices e os 22 gatilhos presentes e válidos.
DO $$
DECLARE t text; n int;
BEGIN
  FOREACH t IN ARRAY ARRAY['ia_credito_carteiras', 'ia_credito_pedidos', 'ia_credito_lotes', 'ia_credito_lancamentos', 'ia_credito_reservas',
      'ia_credito_reserva_lotes', 'ia_credito_cobrancas', 'ia_credito_devolucoes', 'ia_credito_cortesias', 'ia_credito_cortes', 'ia_credito_notificacoes'] LOOP
    IF to_regclass('public.' || t) IS NULL THEN RAISE EXCEPTION '095 postcheck: tabela % ausente', t; END IF;
    SELECT count(*) INTO n FROM pg_trigger WHERE tgrelid = to_regclass('public.' || t) AND NOT tgisinternal AND tgenabled = 'O'
      AND tgname IN (t || '_095_guarda_trg', t || '_095_sem_truncate_trg');
    IF n <> 2 THEN RAISE EXCEPTION '095 postcheck: gatilhos de % ausentes ou desligados', t; END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_constraint WHERE contype = 'c' AND convalidated AND conname IN (
        'ia_credito_carteiras_valores_check', 'ia_credito_carteiras_corte_check', 'ia_credito_lotes_valores_check', 'ia_credito_lotes_compra_check',
        'ia_credito_lancamentos_deltas_check', 'ia_credito_reservas_consumo_check', 'ia_credito_devolucoes_valor_check',
        'ia_credito_devolucoes_integral_check', 'ia_credito_cobrancas_estorno_check', 'ia_credito_cortes_lote_check')) <> 10
    OR (SELECT count(*) FROM pg_constraint WHERE contype = 'u' AND conname IN (
        'ia_credito_pedidos_idempotencia_uk', 'ia_credito_lotes_origem_uk', 'ia_credito_lancamentos_operacao_uk', 'ia_credito_reservas_operacao_uk',
        'ia_credito_cobrancas_pagamento_uk', 'ia_credito_devolucoes_idempotencia_uk', 'ia_credito_devolucoes_pedido_uk',
        'ia_credito_cortesias_idempotencia_uk', 'ia_credito_cortes_empresa_uk')) <> 9 THEN
    RAISE EXCEPTION '095 postcheck: constraints de saldo, idempotência ou unicidade ausentes';
  END IF;
  -- Chaves compostas com empresa_id: lote → carteira; lançamento → lote; alocação → reserva e lote; cobrança/devolução → pedido.
  IF (SELECT count(*) FROM pg_constraint WHERE contype = 'f' AND conrelid IN ('public.ia_credito_lotes'::regclass, 'public.ia_credito_lancamentos'::regclass,
        'public.ia_credito_reserva_lotes'::regclass, 'public.ia_credito_cobrancas'::regclass, 'public.ia_credito_devolucoes'::regclass)
        AND array_length(conkey, 1) >= 2) < 9 THEN
    RAISE EXCEPTION '095 postcheck: chaves estrangeiras compostas por empresa ausentes';
  END IF;
  -- P3-1: as amarras de recurso e de pedido, pelos nomes e com as colunas certas.
  IF (SELECT count(*) FROM pg_constraint WHERE contype = 'f' AND convalidated AND conname IN (
        'ia_credito_lotes_pedido_fk', 'ia_credito_reserva_lotes_reserva_fk', 'ia_credito_reserva_lotes_lote_fk',
        'ia_credito_devolucoes_cobranca_fk', 'ia_credito_devolucoes_lote_fk') AND array_length(conkey, 1) = 3) <> 5 THEN
    RAISE EXCEPTION '095 postcheck: amarras de recurso/pedido ausentes';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_index WHERE indexrelid = 'public.ia_credito_cobrancas_canonica_uk'::regclass AND indisvalid AND indisunique)
    OR NOT EXISTS (SELECT 1 FROM pg_index WHERE indexrelid = 'public.ia_credito_lotes_pedido_uk'::regclass AND indisvalid AND indisunique)
    OR NOT EXISTS (SELECT 1 FROM pg_index WHERE indexrelid = 'public.ia_credito_lotes_consumo_idx'::regclass AND indisvalid)
    OR NOT EXISTS (SELECT 1 FROM pg_index WHERE indexrelid = 'public.ia_credito_pedidos_abertos_idx'::regclass AND indisvalid)
    OR NOT EXISTS (SELECT 1 FROM pg_index WHERE indexrelid = 'public.ia_credito_notificacoes_pendentes_idx'::regclass AND indisvalid)
    OR to_regprocedure('public.kidmais_095_guarda()') IS NULL THEN
    RAISE EXCEPTION '095 postcheck: índices ou função de guarda ausentes';
  END IF;
  RAISE NOTICE '095 postcheck OK';
END $$;
-- Contagem informativa (sem dados pessoais): o schema novo nasce sem nenhum registro.
SELECT (SELECT count(*) FROM ia_credito_carteiras)::int AS carteiras, (SELECT count(*) FROM ia_credito_lotes)::int AS lotes,
       (SELECT count(*) FROM ia_credito_pedidos)::int AS pedidos, (SELECT count(*) FROM ia_credito_lancamentos)::int AS lancamentos;
