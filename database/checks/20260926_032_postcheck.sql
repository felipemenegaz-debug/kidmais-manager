-- Somente leitura.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'pacotes'
      AND column_name = 'revisao_anterior_id' AND is_nullable = 'YES'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'pacotes_empresa_codigo_vigente_uk'
  ) THEN
    RAISE EXCEPTION '032 postcheck: revisão vigente ausente.';
  END IF;
  IF EXISTS (SELECT 1 FROM pacotes WHERE empresa_id IS NOT NULL) THEN
    RAISE EXCEPTION '032 postcheck: pacote atual associado sem identidade comprovada.';
  END IF;
END $$;
SELECT 'pos_032' AS marco, (SELECT count(*) FROM pacotes) AS pacotes;
