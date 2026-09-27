DO $$ BEGIN
  IF to_regclass('public.empresas') IS NULL OR to_regclass('public.festas') IS NULL THEN
    RAISE EXCEPTION '052 precheck: empresas ou festas ausentes.';
  END IF;
  IF to_regclass('public.pagamento_parcelas') IS NULL OR to_regclass('public.pagamento_recebimentos') IS NULL THEN
    RAISE EXCEPTION '052 precheck: recebíveis de contrato ausentes.';
  END IF;
END $$;
