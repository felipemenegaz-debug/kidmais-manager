-- 076 precheck PREPARADO, NÃO EXECUTADO. Somente leitura; não mostra CPF nem dados de clientes.
BEGIN TRANSACTION READ ONLY;
SET LOCAL search_path = public, pg_catalog;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'clientes' AND column_name = 'empresa_id') THEN
    RAISE EXCEPTION '076 precheck: 054 ausente.';
  END IF;
  IF to_regclass('public.clientes_cpf_empresa_canonico_uk') IS NOT NULL THEN
    RAISE EXCEPTION '076 precheck: já aplicada.';
  END IF;
  IF to_regclass('public.clientes_cpf_canonico_uk') IS NULL THEN
    RAISE EXCEPTION '076 precheck: índice global ausente.';
  END IF;
  -- Com o índice global vigente não pode haver duplicidade; conferido mesmo assim.
  IF EXISTS (SELECT 1 FROM clientes WHERE cpf IS NOT NULL AND status <> 'MESCLADO'
             GROUP BY COALESCE(empresa_id, '00000000-0000-0000-0000-000000000000'::uuid), cpf HAVING count(*) > 1) THEN
    RAISE EXCEPTION '076 precheck: CPF duplicado na mesma empresa.';
  END IF;
END $$;
SELECT current_database() AS banco,
       (SELECT count(*) FROM clientes WHERE cpf IS NOT NULL AND status <> 'MESCLADO') AS clientes_com_cpf,
       (SELECT count(*) FROM clientes WHERE empresa_id IS NULL AND cpf IS NOT NULL AND status <> 'MESCLADO') AS legado_sem_empresa_com_cpf;
ROLLBACK;
