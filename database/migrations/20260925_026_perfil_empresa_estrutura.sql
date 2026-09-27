-- Estrutura vazia do Perfil da Empresa. Não autoriza execução.
-- Sem seed, INSERT, concessão, revisão cadastral, BYTEA ou trigger de autorização.
-- Não altera usuarios_administrativos, preços, Festa ou documentos.
-- Referência: docs/modulos/PERFIL-EMPRESA-V1-PROPOSTA-TECNICA.md no commit 9bed49b.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = public, pg_catalog;

DO $$ BEGIN
  IF to_regclass('public.usuarios_administrativos') IS NULL THEN
    RAISE EXCEPTION '026: usuarios_administrativos ausente';
  END IF;
  IF to_regclass('public.perfil_empresas') IS NOT NULL
     OR to_regclass('public.perfil_unidades') IS NOT NULL
     OR to_regclass('public.perfil_empresa_concessoes') IS NOT NULL THEN
    RAISE EXCEPTION '026: estruturas já existem';
  END IF;
END $$;

CREATE TABLE perfil_empresas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo text NOT NULL,
  criado_em timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT perfil_empresas_codigo_check CHECK (codigo = btrim(codigo) AND length(codigo) BETWEEN 1 AND 64)
);
CREATE UNIQUE INDEX perfil_empresas_codigo_uk ON perfil_empresas (codigo);

CREATE TABLE perfil_unidades (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL,
  codigo text NOT NULL,
  criado_em timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT perfil_unidades_empresa_fk FOREIGN KEY (empresa_id)
    REFERENCES perfil_empresas (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT perfil_unidades_codigo_check CHECK (codigo = btrim(codigo) AND length(codigo) BETWEEN 1 AND 64)
);
CREATE UNIQUE INDEX perfil_unidades_codigo_uk ON perfil_unidades (codigo);
CREATE INDEX perfil_unidades_empresa_idx ON perfil_unidades (empresa_id);

CREATE TABLE perfil_empresa_concessoes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL,
  usuario_id uuid NOT NULL,
  capacidade text NOT NULL,
  concedido_por uuid NOT NULL,
  concedido_em timestamptz NOT NULL DEFAULT now(),
  motivo text NOT NULL,
  referencia_autorizacao text NOT NULL,
  revogado_por uuid,
  revogado_em timestamptz,
  motivo_revogacao text,
  CONSTRAINT perfil_empresa_concessoes_empresa_fk FOREIGN KEY (empresa_id)
    REFERENCES perfil_empresas (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT perfil_empresa_concessoes_usuario_fk FOREIGN KEY (usuario_id)
    REFERENCES usuarios_administrativos (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT perfil_empresa_concessoes_concedido_por_fk FOREIGN KEY (concedido_por)
    REFERENCES usuarios_administrativos (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT perfil_empresa_concessoes_revogado_por_fk FOREIGN KEY (revogado_por)
    REFERENCES usuarios_administrativos (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT perfil_empresa_concessoes_capacidade_check CHECK (capacidade IN (
    'PERFIL_CONSULTAR',
    'PERFIL_EDITAR_RASCUNHO',
    'PERFIL_APLICAR',
    'PERFIL_ADMINISTRAR_CONCESSOES'
  )),
  CONSTRAINT perfil_empresa_concessoes_motivo_check CHECK (length(btrim(motivo)) >= 3),
  CONSTRAINT perfil_empresa_concessoes_referencia_check CHECK (length(btrim(referencia_autorizacao)) >= 3),
  -- length(btrim(NULL)) é NULL, e CHECK aceita resultado desconhecido.
  -- O ramo preenchido exige motivo_revogacao IS NOT NULL de forma explícita.
  CONSTRAINT perfil_empresa_concessoes_revogacao_check CHECK (
    (revogado_por IS NULL AND revogado_em IS NULL AND motivo_revogacao IS NULL)
    OR (
      revogado_por IS NOT NULL
      AND revogado_em IS NOT NULL
      AND motivo_revogacao IS NOT NULL
      AND length(btrim(motivo_revogacao)) >= 3
    )
  )
);
CREATE UNIQUE INDEX perfil_empresa_concessao_ativa_uk
  ON perfil_empresa_concessoes (empresa_id, usuario_id, capacidade)
  WHERE revogado_em IS NULL;
CREATE INDEX perfil_empresa_concessoes_usuario_idx
  ON perfil_empresa_concessoes (usuario_id, capacidade);

-- Postcheck de instalação inicial, na mesma transação.
-- Confere zero linhas somente enquanto as tabelas acabaram de nascer.
-- Não reexecutar após o provisionamento: empresa, unidade e concessões
-- passam a existir de propósito, e esta verificação passaria a falhar.
DO $$ BEGIN
  IF (SELECT count(*) FROM perfil_empresas) <> 0
     OR (SELECT count(*) FROM perfil_unidades) <> 0
     OR (SELECT count(*) FROM perfil_empresa_concessoes) <> 0 THEN
    RAISE EXCEPTION '026: instalação inicial não pode conter linhas';
  END IF;
END $$;

COMMIT;
