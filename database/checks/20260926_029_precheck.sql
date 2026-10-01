-- Somente leitura. Não aplica a 029.
DO $$ BEGIN
  IF to_regclass('public.fechamentos') IS NULL
     OR to_regclass('public.pacotes') IS NULL
     OR to_regclass('public.pacote_adicionais') IS NULL
     OR to_regclass('public.pacote_buffet_categorias') IS NULL THEN
    RAISE EXCEPTION '029 precheck: núcleo comercial ausente.';
  END IF;
  IF to_regclass('public.fechamento_pacote_snapshots') IS NOT NULL
     OR EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'fechamentos'
         AND column_name = 'pacote_snapshot_vigente_id'
     ) THEN
    RAISE EXCEPTION '029 precheck: fotografia já aplicada.';
  END IF;
END $$;
SELECT 'pre_029' AS marco, (SELECT count(*) FROM fechamentos) AS fechamentos;
