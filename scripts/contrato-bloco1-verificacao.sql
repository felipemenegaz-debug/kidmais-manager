-- =============================================================================
-- Kidmais Manager — Contrato / Bloco 1
-- Verificação pós-Migration 009 (somente leitura)
-- =============================================================================

-- 1) Ambiente
SELECT
    current_database() AS banco,
    current_schema() AS schema_atual,
    version() AS versao_postgresql;

-- 2) Estruturas esperadas
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN (
      'clientes',
      'fechamentos',
      'contratos',
      'contrato_versoes'
  )
ORDER BY table_name;

-- 3) RG no Cliente
SELECT
    column_name,
    data_type,
    character_maximum_length,
    is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'clientes'
  AND column_name = 'rg';

-- 4) Novos campos persistidos no Fechamento
SELECT
    ordinal_position,
    column_name,
    data_type,
    is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'fechamentos'
  AND column_name IN (
      'responsavel_adicional_id',
      'idade_aniversariante_evento',
      'tema_festa',
      'forma_pagamento_pretendida',
      'alteracoes_pacote',
      'observacoes_cliente',
      'buffet_salgados',
      'buffet_bebidas',
      'buffet_doces',
      'buffet_bolo',
      'buffet_outros'
  )
ORDER BY ordinal_position;

-- 5) Constraints principais do Contrato e dos novos campos
SELECT
    conrelid::regclass::text AS tabela,
    conname AS constraint_name,
    pg_get_constraintdef(oid) AS definicao
FROM pg_constraint
WHERE conrelid IN (
    'public.clientes'::regclass,
    'public.fechamentos'::regclass,
    'public.contratos'::regclass,
    'public.contrato_versoes'::regclass
)
AND (
    conname ILIKE '%rg%'
    OR conname ILIKE '%responsavel_adicional%'
    OR conname ILIKE '%idade_aniversariante_evento%'
    OR conname ILIKE '%forma_pagamento_pretendida%'
    OR conname ILIKE 'contratos_%'
    OR conname ILIKE 'contrato_versoes_%'
)
ORDER BY tabela, constraint_name;

-- 6) Índices específicos do módulo
SELECT
    tablename,
    indexname,
    indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND (
      indexname LIKE 'contratos_%'
      OR indexname LIKE 'contrato_versoes_%'
      OR indexname = 'fechamentos_responsavel_adicional_idx'
  )
ORDER BY tablename, indexname;

-- 7) Fechamentos existentes continuam preservados
SELECT
    status,
    COUNT(*) AS quantidade
FROM fechamentos
GROUP BY status
ORDER BY status;

-- 8) Os registros anteriores à 009 não recebem dados inventados.
--    NULL aqui é esperado para campos que não eram persistidos antes.
SELECT
    id,
    status,
    cliente_id,
    aniversariante_id,
    forma_pagamento_pretendida,
    responsavel_adicional_id,
    idade_aniversariante_evento,
    tema_festa
FROM fechamentos
WHERE status IN ('AGUARDANDO_CONTRATO', 'AGUARDANDO_APROVACAO')
ORDER BY criado_em;

-- 9) Antes do primeiro POST da API, estas tabelas devem estar vazias.
--    Depois dos testes, os totais passam a refletir os Contratos gerados.
SELECT
    (SELECT COUNT(*) FROM contratos) AS contratos,
    (SELECT COUNT(*) FROM contrato_versoes) AS versoes;
