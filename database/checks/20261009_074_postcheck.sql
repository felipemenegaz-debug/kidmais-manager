-- Somente leitura: estrutura, vínculo e unicidade.
DO $$
BEGIN
  IF to_regclass('public.convite_familias') IS NULL OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='convite_respostas' AND column_name='familia_id' AND udt_name='uuid'
  ) THEN RAISE EXCEPTION '074 postcheck: estrutura ausente'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.convite_respostas'::regclass AND conname='convite_respostas_familia_fk' AND contype='f' AND convalidated)
    OR NOT EXISTS (SELECT 1 FROM pg_index WHERE indexrelid='public.convite_respostas_uma_por_familia'::regclass AND indisunique AND indisvalid) THEN
    RAISE EXCEPTION '074 postcheck: integridade ausente';
  END IF;
  IF EXISTS (SELECT 1 FROM public.convite_familias f JOIN public.convites c ON c.id=f.convite_id WHERE f.empresa_id<>c.empresa_id)
    OR EXISTS (SELECT 1 FROM public.convite_respostas r LEFT JOIN public.convite_familias f ON f.id=r.familia_id AND f.convite_id=r.convite_id WHERE r.familia_id IS NOT NULL AND f.id IS NULL) THEN
    RAISE EXCEPTION '074 postcheck: vínculo inválido';
  END IF;
  RAISE NOTICE '074 postcheck OK';
END $$;
