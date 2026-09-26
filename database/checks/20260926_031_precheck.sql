-- Somente leitura. Não aplica a 031.
DO $$ BEGIN
  IF to_regclass('public.pacotes') IS NULL THEN
    RAISE EXCEPTION '031 precheck: pacotes ausente.';
  END IF;
  IF to_regclass('public.empresas') IS NOT NULL THEN
    RAISE EXCEPTION '031 precheck: empresas já existe.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'pacotes' AND column_name = 'empresa_id'
  ) THEN
    RAISE EXCEPTION '031 precheck: pacotes.empresa_id já existe.';
  END IF;
END $$;
SELECT 'pre_031' AS marco, (SELECT count(*) FROM pacotes) AS pacotes;
