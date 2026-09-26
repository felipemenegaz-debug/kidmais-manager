BEGIN;

-- Publicação administrativa da tabela. Não altera preços usados nem fechamentos.
-- A tabela da empresa não nasce ativa: o fechamento público continua na tabela legada.
DO $$ BEGIN
  IF to_regclass('public.tabelas_preco') IS NULL THEN
    RAISE EXCEPTION '033: tabelas de preço ausentes.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'tabelas_preco' AND column_name = 'empresa_id'
  ) THEN
    RAISE EXCEPTION '033: tabelas_preco.empresa_id ausente.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'tabelas_preco' AND column_name = 'publicada_em'
  ) THEN
    RAISE EXCEPTION '033: publicação já existe.';
  END IF;
END $$;

ALTER TABLE tabelas_preco ADD COLUMN publicada_em timestamptz;

COMMIT;
