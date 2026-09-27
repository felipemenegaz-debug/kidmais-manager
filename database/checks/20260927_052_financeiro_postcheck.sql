DO $$ BEGIN
  IF to_regclass('public.financeiro_contas_pagar') IS NULL
     OR to_regclass('public.financeiro_saidas') IS NULL
     OR to_regclass('public.financeiro_categorias') IS NULL
     OR to_regclass('public.financeiro_auditoria') IS NULL THEN
    RAISE EXCEPTION '052 postcheck: tabelas do financeiro ausentes.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'financeiro_saidas_idempotencia_uk'
       AND pg_get_constraintdef(oid) ILIKE '%empresa_id%'
  ) THEN
    RAISE EXCEPTION '052 postcheck: idempotência da saída não está presa à empresa.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'financeiro_contas_pagar_categoria_empresa_fk'
  ) THEN
    RAISE EXCEPTION '052 postcheck: categoria de outra empresa ainda pode ser vinculada.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.financeiro_contas_pagar'::regclass
       AND confdeltype = 'c'
  ) THEN
    RAISE EXCEPTION '052 postcheck: cascade em conta a pagar.';
  END IF;
END $$;
