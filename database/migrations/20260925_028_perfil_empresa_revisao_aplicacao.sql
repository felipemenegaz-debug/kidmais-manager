-- Correção do ciclo da revisão. Não reescreve 026 nem 027.
-- Não autoriza execução. Sem empresa, concessão, seed, BYTEA, logo ou PDF.
-- Não altera contratos, snapshots, preços, schema_mvp_kidmais.sql nem usuarios_administrativos.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = public, pg_catalog;

DO $$ BEGIN
  IF to_regclass('public.perfil_empresa_revisoes') IS NULL THEN
    RAISE EXCEPTION '028: revisões 027 ausentes';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'perfil_empresa_revisoes' AND column_name = 'aplicado_por'
  ) THEN
    RAISE EXCEPTION '028: coluna aplicado_por já existe';
  END IF;
END $$;

ALTER TABLE public.perfil_empresa_revisoes
  ADD COLUMN aplicado_por uuid,
  ADD COLUMN atualizado_em timestamptz NOT NULL DEFAULT now();

ALTER TABLE public.perfil_empresa_revisoes
  ADD CONSTRAINT perfil_empresa_revisoes_aplicado_por_fk
  FOREIGN KEY (aplicado_por) REFERENCES public.usuarios_administrativos (id)
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE public.perfil_empresa_revisoes
  DROP CONSTRAINT perfil_empresa_revisoes_ciclo_check;

ALTER TABLE public.perfil_empresa_revisoes
  ADD CONSTRAINT perfil_empresa_revisoes_ciclo_check CHECK (
    (estado = 'RASCUNHO' AND aplicado_em IS NULL AND motivo IS NULL AND aplicado_por IS NULL)
    OR (
      estado = 'APLICADA'
      AND aplicado_em IS NOT NULL
      AND motivo IS NOT NULL
      AND length(btrim(motivo)) >= 3
      AND aplicado_por IS NOT NULL
    )
  );

COMMIT;
