BEGIN;

-- Kidmais Manager — Clientes / CRM
-- Migration 004: central de duplicidades e registro permanente de mesclagens.

CREATE TABLE mesclagens_clientes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    cliente_principal_id uuid NOT NULL,
    cliente_secundario_id uuid NOT NULL,
    motivo text NOT NULL,
    resolucao_campos jsonb NOT NULL DEFAULT '{}'::jsonb,
    executado_por_usuario_id uuid NOT NULL,
    criado_em timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT mesclagens_principal_fk
        FOREIGN KEY (cliente_principal_id)
        REFERENCES clientes(id)
        ON DELETE RESTRICT,
    CONSTRAINT mesclagens_secundario_fk
        FOREIGN KEY (cliente_secundario_id)
        REFERENCES clientes(id)
        ON DELETE RESTRICT,
    CONSTRAINT mesclagens_clientes_distintos CHECK (cliente_principal_id <> cliente_secundario_id),
    CONSTRAINT mesclagens_motivo_nao_vazio CHECK (btrim(motivo) <> ''),
    CONSTRAINT mesclagens_resolucao_objeto CHECK (jsonb_typeof(resolucao_campos) = 'object'),
    CONSTRAINT mesclagens_secundario_uk UNIQUE (cliente_secundario_id)
);

CREATE INDEX mesclagens_principal_idx
    ON mesclagens_clientes (cliente_principal_id, criado_em DESC);

CREATE TABLE possiveis_duplicidades_cliente (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    cliente_a_id uuid NOT NULL,
    cliente_b_id uuid NOT NULL,
    motivos text[] NOT NULL,
    status varchar(16) NOT NULL DEFAULT 'PENDENTE',
    observacoes text,
    criado_em timestamptz NOT NULL DEFAULT now(),
    analisado_por_usuario_id uuid,
    analisado_em timestamptz,
    mesclagem_id uuid,

    CONSTRAINT duplicidades_cliente_a_fk
        FOREIGN KEY (cliente_a_id)
        REFERENCES clientes(id)
        ON DELETE RESTRICT,
    CONSTRAINT duplicidades_cliente_b_fk
        FOREIGN KEY (cliente_b_id)
        REFERENCES clientes(id)
        ON DELETE RESTRICT,
    CONSTRAINT duplicidades_mesclagem_fk
        FOREIGN KEY (mesclagem_id)
        REFERENCES mesclagens_clientes(id)
        ON DELETE RESTRICT,
    CONSTRAINT duplicidades_clientes_distintos CHECK (cliente_a_id <> cliente_b_id),
    CONSTRAINT duplicidades_par_ordenado CHECK (cliente_a_id < cliente_b_id),
    CONSTRAINT duplicidades_motivos_nao_vazios CHECK (cardinality(motivos) > 0),
    CONSTRAINT duplicidades_status_check CHECK (status IN ('PENDENTE', 'DESCARTADA', 'CONFIRMADA', 'MESCLADA')),
    CONSTRAINT duplicidades_analise_consistencia CHECK (
        (status = 'PENDENTE' AND analisado_em IS NULL AND analisado_por_usuario_id IS NULL)
        OR
        (status <> 'PENDENTE' AND analisado_em IS NOT NULL AND analisado_por_usuario_id IS NOT NULL)
    ),
    CONSTRAINT duplicidades_mesclagem_consistencia CHECK (
        (status = 'MESCLADA' AND mesclagem_id IS NOT NULL)
        OR
        (status <> 'MESCLADA' AND mesclagem_id IS NULL)
    ),
    CONSTRAINT duplicidades_par_uk UNIQUE (cliente_a_id, cliente_b_id)
);

CREATE INDEX duplicidades_status_criado_em_idx
    ON possiveis_duplicidades_cliente (status, criado_em DESC);

CREATE INDEX duplicidades_cliente_a_idx
    ON possiveis_duplicidades_cliente (cliente_a_id, status);

CREATE INDEX duplicidades_cliente_b_idx
    ON possiveis_duplicidades_cliente (cliente_b_id, status);

COMMIT;
