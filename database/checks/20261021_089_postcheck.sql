-- Somente leitura: tabela, constraints, índices e gatilhos da 089 presentes e válidos.
DO $$
DECLARE colunas text[];
BEGIN
  SELECT array_agg(column_name::text ORDER BY column_name) INTO colunas FROM information_schema.columns
    WHERE table_schema='public' AND table_name='assinatura_encerramentos';
  IF colunas IS DISTINCT FROM ARRAY['acesso_pago_encerrado_em','cancelamento_provedor','chave_idempotencia','ciclo','cobranca_provedor_id','data_ativacao',
      'dias_ciclo','dias_utilizados','email_situacao','empresa_id','estorno_atualizado_em','estorno_concluido_em','estorno_modo','estorno_referencia',
      'estorno_situacao','estorno_status_provedor','forma_pagamento','id','inicio_ciclo','motivo','periodo_fim_anterior','prazo_processamento',
      'protocolo','provedor_assinatura_id','regra','situacao_anterior','solicitado_em','solicitado_por','tipo','valor_devolucao_centavos',
      'valor_pago_centavos']::text[] THEN
    RAISE EXCEPTION '089 postcheck: colunas ausentes ou inesperadas em assinatura_encerramentos';
  END IF;
  IF (SELECT count(*) FROM pg_constraint WHERE conrelid='public.assinatura_encerramentos'::regclass AND contype='c' AND convalidated
        AND conname IN ('assinatura_encerramentos_devolucao_check','assinatura_encerramentos_integral_check',
                        'assinatura_encerramentos_proporcional_check','assinatura_encerramentos_conclusao_check')) <> 4
    OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.assinatura_encerramentos'::regclass AND conname='assinatura_encerramentos_idempotencia_uk' AND contype='u')
    OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.assinatura_encerramentos'::regclass AND contype='f' AND confrelid='public.empresa_assinaturas'::regclass) THEN
    RAISE EXCEPTION '089 postcheck: constraints de devolução, idempotência ou chave estrangeira ausentes';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_index WHERE indexrelid='public.assinatura_encerramentos_cobranca_uk'::regclass AND indisvalid AND indisunique)
    OR NOT EXISTS (SELECT 1 FROM pg_index WHERE indexrelid='public.assinatura_encerramentos_garantia_uk'::regclass AND indisvalid AND indisunique)
    OR NOT EXISTS (SELECT 1 FROM pg_index WHERE indexrelid='public.assinatura_encerramentos_empresa_idx'::regclass AND indisvalid)
    OR NOT EXISTS (SELECT 1 FROM pg_index WHERE indexrelid='public.assinatura_encerramentos_abertos_idx'::regclass AND indisvalid)
    OR (SELECT count(*) FROM pg_trigger WHERE tgrelid='public.assinatura_encerramentos'::regclass AND NOT tgisinternal AND tgenabled = 'O'
        AND tgname IN ('assinatura_encerramentos_089_guarda_trg','assinatura_encerramentos_089_sem_truncate_trg')) <> 2 THEN
    RAISE EXCEPTION '089 postcheck: índices ou gatilhos ausentes';
  END IF;
  RAISE NOTICE '089 postcheck OK';
END $$;
-- Contagem informativa (sem dados pessoais).
SELECT tipo, estorno_situacao, count(*) AS pedidos FROM assinatura_encerramentos GROUP BY tipo, estorno_situacao ORDER BY tipo, estorno_situacao;
