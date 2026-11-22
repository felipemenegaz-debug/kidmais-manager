-- 129 down. NUNCA pelo aplicador; só com autorização própria de Felipe. Trava a tabela antes de ler: com qualquer linha,
-- recusa (o histórico de tentativas não se apaga); vazia, remove a tabela e a função na mesma transação.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;
LOCK TABLE public.operacao_migration_tentativas IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.operacao_migration_tentativas) THEN
    RAISE EXCEPTION '129 down: operacao_migration_tentativas tem linhas; recusado';
  END IF;
END $$;
DROP TABLE public.operacao_migration_tentativas;
DROP FUNCTION public.operacao_migration_tentativas_terminal();
COMMIT;
