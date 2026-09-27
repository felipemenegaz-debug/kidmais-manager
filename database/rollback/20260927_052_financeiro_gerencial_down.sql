BEGIN;
DO $$ BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('kidmais-052-down'));
  IF to_regclass('public.financeiro_saidas') IS NOT NULL THEN
    LOCK TABLE public.financeiro_saidas IN SHARE ROW EXCLUSIVE MODE;
  END IF;
  IF to_regclass('public.financeiro_contas_pagar') IS NOT NULL THEN
    LOCK TABLE public.financeiro_contas_pagar IN SHARE ROW EXCLUSIVE MODE;
  END IF;
  IF to_regclass('public.financeiro_auditoria') IS NOT NULL THEN
    LOCK TABLE public.financeiro_auditoria IN SHARE ROW EXCLUSIVE MODE;
  END IF;
  IF to_regclass('public.financeiro_saidas') IS NOT NULL
     AND EXISTS (SELECT 1 FROM financeiro_saidas) THEN
    RAISE EXCEPTION '052 down: ainda há pagamento de conta a pagar.';
  END IF;
  IF to_regclass('public.financeiro_contas_pagar') IS NOT NULL
     AND EXISTS (SELECT 1 FROM financeiro_contas_pagar) THEN
    RAISE EXCEPTION '052 down: ainda há conta a pagar.';
  END IF;
  IF to_regclass('public.financeiro_auditoria') IS NOT NULL
     AND EXISTS (SELECT 1 FROM financeiro_auditoria) THEN
    RAISE EXCEPTION '052 down: ainda há auditoria financeira.';
  END IF;
END $$;
DROP TABLE IF EXISTS financeiro_auditoria;
DROP TABLE IF EXISTS financeiro_saidas;
DROP TABLE IF EXISTS financeiro_contas_pagar;
DROP TABLE IF EXISTS financeiro_recorrencias;
DROP TABLE IF EXISTS financeiro_categorias;
COMMIT;
