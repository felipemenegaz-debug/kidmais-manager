-- 129 precheck. Somente leitura. Nada da 129 pode existir (nem a tabela, nem a função, nem a sequência).
BEGIN TRANSACTION READ ONLY;
SET LOCAL search_path = public, pg_catalog;
DO $$
BEGIN
  IF to_regclass('public.operacao_migration_tentativas') IS NOT NULL
     OR to_regclass('public.operacao_migration_tentativas_id_seq') IS NOT NULL
     OR to_regclass('public.operacao_migration_tentativas_ativa_uk') IS NOT NULL
     OR to_regprocedure('public.operacao_migration_tentativas_terminal()') IS NOT NULL THEN
    RAISE EXCEPTION '129 precheck: 129 já presente (inteira ou parcial)';
  END IF;
END $$;
SELECT true AS aprovado;
ROLLBACK;
