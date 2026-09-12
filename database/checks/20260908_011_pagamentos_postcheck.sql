-- =============================================================================
-- Kidmais Manager
-- Pós-verificação — Migration 011 Pagamentos
-- SOMENTE LEITURA
-- =============================================================================

-- 1. Todas as estruturas novas devem existir.
SELECT
    to_regclass('public.pagamentos') AS pagamentos,
    to_regclass('public.pagamento_planos') AS pagamento_planos,
    to_regclass('public.pagamento_parcelas') AS pagamento_parcelas,
    to_regclass('public.pagamento_recebimentos') AS pagamento_recebimentos,
    to_regclass('public.pagamento_recebimento_alocacoes') AS pagamento_recebimento_alocacoes,
    to_regclass('public.pagamento_estornos') AS pagamento_estornos,
    to_regclass('public.pagamento_comprovantes') AS pagamento_comprovantes;

-- 2. A migration NÃO faz backfill. Em uma base sem Pagamentos prévios, tudo deve iniciar em zero.
SELECT
    (SELECT COUNT(*) FROM pagamentos) AS pagamentos,
    (SELECT COUNT(*) FROM pagamento_planos) AS planos,
    (SELECT COUNT(*) FROM pagamento_parcelas) AS parcelas,
    (SELECT COUNT(*) FROM pagamento_recebimentos) AS recebimentos,
    (SELECT COUNT(*) FROM pagamento_recebimento_alocacoes) AS alocacoes,
    (SELECT COUNT(*) FROM pagamento_estornos) AS estornos,
    (SELECT COUNT(*) FROM pagamento_comprovantes) AS comprovantes;

-- 3. Conferir FKs, UNIQUEs e CHECKs do domínio.
SELECT
    c.relname AS tabela,
    pc.conname AS constraint_name,
    pg_get_constraintdef(pc.oid) AS definicao
FROM pg_constraint pc
JOIN pg_class c ON c.oid = pc.conrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN (
      'pagamentos',
      'pagamento_planos',
      'pagamento_parcelas',
      'pagamento_recebimentos',
      'pagamento_recebimento_alocacoes',
      'pagamento_estornos',
      'pagamento_comprovantes'
  )
ORDER BY c.relname, pc.conname;

-- 4. Conferir índices importantes de idempotência e plano ativo.
SELECT
    tablename,
    indexname,
    indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename IN (
      'pagamentos',
      'pagamento_planos',
      'pagamento_parcelas',
      'pagamento_recebimentos',
      'pagamento_recebimento_alocacoes',
      'pagamento_estornos',
      'pagamento_comprovantes'
  )
ORDER BY tablename, indexname;

-- 5. Triggers de atualizado_em esperados.
SELECT
    c.relname AS tabela,
    t.tgname AS trigger_name,
    pg_get_triggerdef(t.oid) AS definicao
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN (
      'pagamentos',
      'pagamento_parcelas',
      'pagamento_recebimentos',
      'pagamento_estornos'
  )
  AND NOT t.tgisinternal
ORDER BY c.relname, t.tgname;

-- 6. O schema legado NÃO deve ser materializado pela migration.
SELECT
    to_regclass('public.parcelas') AS parcelas_legado,
    to_regclass('public.taxas_cartao') AS taxas_cartao_legado;
