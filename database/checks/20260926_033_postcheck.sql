-- Somente leitura. A publicação nova não marca tabelas antigas como publicadas.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'tabelas_preco'
      AND column_name = 'publicada_em' AND is_nullable = 'YES'
  ) THEN
    RAISE EXCEPTION '033 postcheck: publicada_em ausente ou obrigatório.';
  END IF;
  IF EXISTS (SELECT 1 FROM tabelas_preco WHERE publicada_em IS NOT NULL) THEN
    RAISE EXCEPTION '033 postcheck: tabela existente foi marcada como publicada.';
  END IF;
END $$;
SELECT 'pos_033' AS marco, (SELECT count(*) FROM fechamentos) AS fechamentos;
