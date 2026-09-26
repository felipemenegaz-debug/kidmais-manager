-- Somente leitura. Fechamentos antigos podem permanecer sem fotografia.
DO $$ BEGIN
  IF to_regclass('public.fechamento_pacote_snapshots') IS NULL
     OR to_regclass('public.fechamento_pacote_composicao') IS NULL
     OR to_regprocedure('public.kidmais_029_fotografia_imutavel()') IS NULL THEN
    RAISE EXCEPTION '029 postcheck: fotografia ausente.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'fechamentos'
      AND column_name = 'pacote_snapshot_vigente_id'
      AND is_nullable = 'YES'
  ) THEN
    RAISE EXCEPTION '029 postcheck: ponteiro vigente obrigatório ou ausente.';
  END IF;
  IF (
    SELECT count(*) FROM pg_trigger
    WHERE tgname IN (
      'fechamento_pacote_snapshots_imutavel',
      'fechamento_pacote_composicao_imutavel'
    ) AND NOT tgisinternal
  ) <> 2 THEN
    RAISE EXCEPTION '029 postcheck: imutabilidade ausente.';
  END IF;
END $$;
SELECT 'pos_029' AS marco,
       (SELECT count(*) FROM fechamentos WHERE pacote_snapshot_vigente_id IS NULL) AS fechamentos_sem_fotografia;
