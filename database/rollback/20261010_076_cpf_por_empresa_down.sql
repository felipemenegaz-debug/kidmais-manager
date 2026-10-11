-- 076 rollback PREPARADO, NÃO EXECUTADO. Volta ao índice global; nunca apaga ou mescla clientes.
-- Se o mesmo CPF já existir em empresas diferentes (permitido depois da 076), ABORTA: a reconciliação é manual.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;
DO $$ BEGIN
  IF to_regclass('public.clientes_cpf_empresa_canonico_uk') IS NULL OR to_regclass('public.clientes_cpf_canonico_uk') IS NOT NULL THEN
    RAISE EXCEPTION '076 rollback: estado diferente do aplicado pela 076.';
  END IF;
END $$;
LOCK TABLE clientes IN SHARE ROW EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM clientes WHERE cpf IS NOT NULL AND status <> 'MESCLADO' GROUP BY cpf HAVING count(*) > 1) THEN
    RAISE EXCEPTION '076 rollback: CPF repetido entre empresas; o índice global não pode voltar sem reconciliação manual.';
  END IF;
END $$;
CREATE UNIQUE INDEX clientes_cpf_canonico_uk ON clientes (cpf) WHERE cpf IS NOT NULL AND status <> 'MESCLADO';
DROP INDEX clientes_cpf_empresa_canonico_uk;
COMMIT;
