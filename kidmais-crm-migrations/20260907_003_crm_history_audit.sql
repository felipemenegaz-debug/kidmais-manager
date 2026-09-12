BEGIN;

-- Kidmais Manager — Clientes / CRM
-- Migration 003: linha do tempo funcional e auditoria técnica.

CREATE TABLE eventos_historico_cliente (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    cliente_id uuid NOT NULL,
    cliente_origem_id uuid,
    tipo_evento text NOT NULL,
    origem text NOT NULL,
    entidade_tipo text,
    entidade_id uuid,
    usuario_id uuid,
    detalhe text,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    critico boolean NOT NULL DEFAULT false,
    criado_em timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT historico_cliente_fk
        FOREIGN KEY (cliente_id)
        REFERENCES clientes(id)
        ON DELETE RESTRICT,
    CONSTRAINT historico_cliente_origem_fk
        FOREIGN KEY (cliente_origem_id)
        REFERENCES clientes(id)
        ON DELETE RESTRICT,
    CONSTRAINT historico_tipo_evento_nao_vazio CHECK (btrim(tipo_evento) <> ''),
    CONSTRAINT historico_origem_nao_vazia CHECK (btrim(origem) <> ''),
    CONSTRAINT historico_metadata_objeto CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX historico_cliente_criado_em_idx
    ON eventos_historico_cliente (cliente_id, criado_em DESC);

CREATE INDEX historico_cliente_origem_idx
    ON eventos_historico_cliente (cliente_origem_id, criado_em DESC)
    WHERE cliente_origem_id IS NOT NULL;

CREATE INDEX historico_entidade_idx
    ON eventos_historico_cliente (entidade_tipo, entidade_id, criado_em DESC)
    WHERE entidade_tipo IS NOT NULL AND entidade_id IS NOT NULL;

CREATE TABLE auditoria (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    cliente_id uuid,
    ator_tipo varchar(16) NOT NULL,
    usuario_id uuid,
    acao text NOT NULL,
    entidade_tipo text NOT NULL,
    entidade_id uuid NOT NULL,
    dados_antes jsonb,
    dados_depois jsonb,
    justificativa text,
    origem text NOT NULL,
    request_id uuid,
    ip inet,
    user_agent text,
    criado_em timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT auditoria_cliente_fk
        FOREIGN KEY (cliente_id)
        REFERENCES clientes(id)
        ON DELETE RESTRICT,
    CONSTRAINT auditoria_ator_tipo_check CHECK (ator_tipo IN ('USUARIO', 'CLIENTE', 'SISTEMA')),
    CONSTRAINT auditoria_acao_nao_vazia CHECK (btrim(acao) <> ''),
    CONSTRAINT auditoria_entidade_tipo_nao_vazio CHECK (btrim(entidade_tipo) <> ''),
    CONSTRAINT auditoria_origem_nao_vazia CHECK (btrim(origem) <> ''),
    CONSTRAINT auditoria_dados_antes_objeto CHECK (
        dados_antes IS NULL OR jsonb_typeof(dados_antes) = 'object'
    ),
    CONSTRAINT auditoria_dados_depois_objeto CHECK (
        dados_depois IS NULL OR jsonb_typeof(dados_depois) = 'object'
    )
);

CREATE INDEX auditoria_cliente_criado_em_idx
    ON auditoria (cliente_id, criado_em DESC)
    WHERE cliente_id IS NOT NULL;

CREATE INDEX auditoria_entidade_idx
    ON auditoria (entidade_tipo, entidade_id, criado_em DESC);

CREATE INDEX auditoria_usuario_idx
    ON auditoria (usuario_id, criado_em DESC)
    WHERE usuario_id IS NOT NULL;

CREATE INDEX auditoria_request_id_idx
    ON auditoria (request_id)
    WHERE request_id IS NOT NULL;

-- Auditoria é append-only. Correções devem gerar um novo registro, nunca alterar o anterior.
CREATE OR REPLACE FUNCTION kidmais_bloquear_mutacao_auditoria()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'Registros de auditoria são imutáveis';
END;
$$;

CREATE TRIGGER auditoria_bloquear_update_delete_trg
BEFORE UPDATE OR DELETE ON auditoria
FOR EACH ROW
EXECUTE FUNCTION kidmais_bloquear_mutacao_auditoria();

COMMIT;
