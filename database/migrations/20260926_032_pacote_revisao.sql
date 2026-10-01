BEGIN;

-- Revisão administrativa do pacote. A linha utilizada permanece.
-- Não associa empresa aos pacotes atuais e não apaga linhas.
DO $$ BEGIN
  IF to_regclass('public.empresas') IS NULL
     OR to_regclass('public.pacotes') IS NULL
     OR to_regclass('public.fechamentos') IS NULL
     OR to_regclass('public.fechamento_pacote_snapshots') IS NULL
     OR to_regclass('public.fechamento_revisoes') IS NULL THEN
    RAISE EXCEPTION '032: empresa, pacote ou referência histórica ausente.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'pacotes' AND column_name = 'revisao_anterior_id'
  ) THEN
    RAISE EXCEPTION '032: revisão de pacote já existe.';
  END IF;
END $$;

ALTER TABLE pacotes
  ADD COLUMN revisao_anterior_id uuid,
  ADD COLUMN vigente boolean NOT NULL DEFAULT true,
  ADD COLUMN arquivado_em timestamptz;

ALTER TABLE pacotes
  ADD CONSTRAINT pacotes_revisao_anterior_fk
  FOREIGN KEY (revisao_anterior_id) REFERENCES pacotes(id) ON UPDATE RESTRICT ON DELETE RESTRICT;

DROP INDEX IF EXISTS pacotes_empresa_codigo_uk;

CREATE UNIQUE INDEX pacotes_empresa_codigo_vigente_uk
  ON pacotes (empresa_id, codigo)
  WHERE empresa_id IS NOT NULL AND vigente;

COMMIT;
