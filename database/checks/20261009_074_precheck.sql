-- Somente leitura; recusa execução repetida ou parcial.
DO $$
BEGIN
  IF to_regclass('public.convites') IS NULL OR to_regclass('public.convite_respostas') IS NULL THEN
    RAISE EXCEPTION '074 precheck: dependência 073 ausente.';
  END IF;
  IF to_regclass('public.convite_familias') IS NOT NULL OR EXISTS (
    SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='convite_respostas' AND column_name='familia_id'
  ) OR to_regclass('public.convite_respostas_uma_por_familia') IS NOT NULL THEN
    RAISE EXCEPTION '074 precheck: aplicação anterior ou parcial encontrada.';
  END IF;
  RAISE NOTICE '074 precheck OK';
END $$;
