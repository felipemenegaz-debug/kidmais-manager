-- Cadastro básico do Perfil da Empresa. Não autoriza execução.
-- Sem empresa real, sem concessão, sem seed, sem BYTEA, sem logo e sem PDF.
-- Não altera contratos, snapshots, preços nem usuarios_administrativos.
-- A V1 de uma empresa e uma unidade fica nos serviços, sem índice de singleton.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = public, pg_catalog;

DO $$ BEGIN
  IF to_regclass('public.perfil_empresas') IS NULL
     OR to_regclass('public.perfil_unidades') IS NULL THEN
    RAISE EXCEPTION '027: estrutura 026 ausente';
  END IF;
  IF to_regclass('public.perfil_empresa_revisoes') IS NOT NULL THEN
    RAISE EXCEPTION '027: cadastro já existe';
  END IF;
END $$;

ALTER TABLE perfil_empresas
  ADD COLUMN nome_comercial text,
  ADD COLUMN razao_social text,
  ADD COLUMN cnpj text,
  ADD COLUMN sede_cep text,
  ADD COLUMN sede_logradouro text,
  ADD COLUMN sede_numero text,
  ADD COLUMN sede_sem_numero boolean NOT NULL DEFAULT false,
  ADD COLUMN sede_complemento text,
  ADD COLUMN sede_bairro text,
  ADD COLUMN sede_cidade text,
  ADD COLUMN sede_uf text,
  ADD COLUMN sede_pais text NOT NULL DEFAULT 'BR',
  ADD COLUMN versao integer NOT NULL DEFAULT 0,
  ADD COLUMN atualizado_em timestamptz,
  ADD CONSTRAINT perfil_empresas_cnpj_check CHECK (cnpj IS NULL OR (cnpj = upper(cnpj) AND length(cnpj) = 14)),
  ADD CONSTRAINT perfil_empresas_pais_check CHECK (sede_pais = 'BR'),
  ADD CONSTRAINT perfil_empresas_sem_numero_check CHECK (sede_sem_numero = false OR sede_numero IS NULL);

ALTER TABLE perfil_unidades
  ADD COLUMN nome text,
  ADD COLUMN mesmo_endereco_sede boolean NOT NULL DEFAULT false,
  ADD COLUMN cep text,
  ADD COLUMN logradouro text,
  ADD COLUMN numero text,
  ADD COLUMN sem_numero boolean NOT NULL DEFAULT false,
  ADD COLUMN complemento text,
  ADD COLUMN bairro text,
  ADD COLUMN cidade text,
  ADD COLUMN uf text,
  ADD COLUMN pais text NOT NULL DEFAULT 'BR',
  ADD COLUMN referencia_chegada text,
  ADD COLUMN telefone text,
  ADD COLUMN whatsapp text,
  ADD COLUMN email_comercial text,
  ADD COLUMN site text,
  ADD COLUMN instagram text,
  ADD CONSTRAINT perfil_unidades_pais_check CHECK (pais = 'BR'),
  ADD CONSTRAINT perfil_unidades_sem_numero_check CHECK (sem_numero = false OR numero IS NULL);

CREATE TABLE perfil_empresa_revisoes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL,
  unidade_id uuid NOT NULL,
  numero integer NOT NULL,
  estado text NOT NULL,
  versao_base integer NOT NULL,
  edicao integer NOT NULL,
  conteudo jsonb NOT NULL,
  motivo text,
  autor_id uuid NOT NULL,
  criado_em timestamptz NOT NULL DEFAULT now(),
  aplicado_em timestamptz,
  CONSTRAINT perfil_empresa_revisoes_empresa_fk FOREIGN KEY (empresa_id)
    REFERENCES perfil_empresas (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT perfil_empresa_revisoes_unidade_fk FOREIGN KEY (unidade_id)
    REFERENCES perfil_unidades (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT perfil_empresa_revisoes_autor_fk FOREIGN KEY (autor_id)
    REFERENCES usuarios_administrativos (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT perfil_empresa_revisoes_estado_check CHECK (estado IN ('RASCUNHO', 'APLICADA')),
  CONSTRAINT perfil_empresa_revisoes_edicao_check CHECK (edicao >= 1),
  CONSTRAINT perfil_empresa_revisoes_ciclo_check CHECK (
    (estado = 'RASCUNHO' AND aplicado_em IS NULL AND motivo IS NULL)
    OR (estado = 'APLICADA' AND aplicado_em IS NOT NULL AND length(btrim(motivo)) >= 3)
  )
);
CREATE UNIQUE INDEX perfil_empresa_revisao_numero_uk ON perfil_empresa_revisoes (empresa_id, numero);
CREATE UNIQUE INDEX perfil_empresa_rascunho_uk ON perfil_empresa_revisoes (empresa_id) WHERE estado = 'RASCUNHO';

-- Zero linhas de revisão só vale na instalação inicial, antes de qualquer rascunho.
DO $$ BEGIN
  IF (SELECT count(*) FROM perfil_empresa_revisoes) <> 0 THEN
    RAISE EXCEPTION '027: instalação inicial não pode conter revisões';
  END IF;
END $$;

COMMIT;
