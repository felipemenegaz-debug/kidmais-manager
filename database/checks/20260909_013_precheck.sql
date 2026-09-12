-- Leitura/precondições; executar antes do UP em transação.
DO $$
DECLARE nome text;
BEGIN
  FOREACH nome IN ARRAY ARRAY['usuarios_administrativos','sessoes_administrativas','limites_autenticacao','contrato_fluxos','contrato_edicoes','contrato_documentos','contrato_assinaturas','contrato_pendencias_financeiras'] LOOP
    IF to_regclass('public.'||nome) IS NOT NULL THEN RAISE EXCEPTION '013: objeto já existe: %',nome; END IF;
  END LOOP;
  FOREACH nome IN ARRAY ARRAY['contratos','contrato_versoes','validacoes_identidade_cliente','pagamentos','clientes','fechamentos','auditoria','eventos_historico_cliente'] LOOP
    IF to_regclass('public.'||nome) IS NULL THEN RAISE EXCEPTION '013: pré-requisito ausente: %',nome; END IF;
  END LOOP;
  IF to_regclass('public.contrato_versoes_corrente_uk') IS NULL
    OR to_regprocedure('public.kidmais_set_atualizado_em()') IS NULL
    OR to_regprocedure('pg_catalog.sha256(bytea)') IS NULL THEN
    RAISE EXCEPTION '013: índice/função pré-requisito ausente';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='fechamentos' AND column_name='condicao_pagamento' AND data_type='jsonb') THEN
    RAISE EXCEPTION '013 exige Migration 012 física';
  END IF;
END $$;
