BEGIN;

-- Kidmais Manager — Clientes / CRM
-- Migration 002: Cliente, Aniversariante e Responsável adicional.

CREATE TABLE clientes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    nome_completo text NOT NULL,
    cpf char(11),
    telefone varchar(15),
    whatsapp varchar(15),
    email text,
    cep char(8),
    logradouro text,
    numero text,
    complemento text,
    bairro text,
    cidade text,
    uf char(2),
    observacoes text,

    status varchar(16) NOT NULL DEFAULT 'ATIVO',
    cliente_principal_id uuid,
    mesclado_em timestamptz,

    criado_por_usuario_id uuid,
    atualizado_por_usuario_id uuid,
    criado_em timestamptz NOT NULL DEFAULT now(),
    atualizado_em timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT clientes_nome_nao_vazio CHECK (btrim(nome_completo) <> ''),
    CONSTRAINT clientes_cpf_formato CHECK (cpf IS NULL OR cpf ~ '^[0-9]{11}$'),
    CONSTRAINT clientes_telefone_formato CHECK (telefone IS NULL OR telefone ~ '^[0-9]{10,15}$'),
    CONSTRAINT clientes_whatsapp_formato CHECK (whatsapp IS NULL OR whatsapp ~ '^[0-9]{10,15}$'),
    CONSTRAINT clientes_email_nao_vazio CHECK (email IS NULL OR btrim(email) <> ''),
    CONSTRAINT clientes_cep_formato CHECK (cep IS NULL OR cep ~ '^[0-9]{8}$'),
    CONSTRAINT clientes_uf_formato CHECK (uf IS NULL OR uf ~ '^[A-Z]{2}$'),
    CONSTRAINT clientes_status_check CHECK (status IN ('ATIVO', 'INATIVO', 'MESCLADO')),
    CONSTRAINT clientes_mesclagem_consistencia CHECK (
        (
            status = 'MESCLADO'
            AND cliente_principal_id IS NOT NULL
            AND mesclado_em IS NOT NULL
            AND cliente_principal_id <> id
        )
        OR
        (
            status <> 'MESCLADO'
            AND cliente_principal_id IS NULL
            AND mesclado_em IS NULL
        )
    ),
    CONSTRAINT clientes_cliente_principal_fk
        FOREIGN KEY (cliente_principal_id)
        REFERENCES clientes(id)
        ON DELETE RESTRICT
        DEFERRABLE INITIALLY IMMEDIATE
);

-- Somente um Cliente canônico pode possuir determinado CPF.
-- Um registro já mesclado permanece fisicamente no banco e fica fora desta unicidade.
CREATE UNIQUE INDEX clientes_cpf_canonico_uk
    ON clientes (cpf)
    WHERE cpf IS NOT NULL AND status <> 'MESCLADO';

CREATE INDEX clientes_telefone_idx
    ON clientes (telefone)
    WHERE telefone IS NOT NULL;

CREATE INDEX clientes_whatsapp_idx
    ON clientes (whatsapp)
    WHERE whatsapp IS NOT NULL;

CREATE INDEX clientes_email_lower_idx
    ON clientes (lower(email))
    WHERE email IS NOT NULL;

CREATE INDEX clientes_nome_trgm_idx
    ON clientes USING gin (lower(nome_completo) gin_trgm_ops);

CREATE INDEX clientes_cliente_principal_idx
    ON clientes (cliente_principal_id)
    WHERE cliente_principal_id IS NOT NULL;

-- Garante que um registro MESCLADO aponte diretamente para um Cliente canônico,
-- evitando cadeias de mesclagem e ciclos lógicos.
CREATE OR REPLACE FUNCTION kidmais_validar_cliente_principal()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_status varchar(16);
BEGIN
    IF NEW.status = 'MESCLADO' THEN
        IF NEW.cliente_principal_id IS NULL THEN
            RAISE EXCEPTION 'Cliente MESCLADO exige cliente_principal_id';
        END IF;

        IF NEW.cliente_principal_id = NEW.id THEN
            RAISE EXCEPTION 'Cliente não pode ser principal de si próprio';
        END IF;

        SELECT status
          INTO v_status
          FROM clientes
         WHERE id = NEW.cliente_principal_id;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Cliente principal % não existe', NEW.cliente_principal_id;
        END IF;

        IF v_status = 'MESCLADO' THEN
            RAISE EXCEPTION 'Cliente principal deve ser canônico e não pode estar MESCLADO';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER clientes_validar_cliente_principal_trg
BEFORE INSERT OR UPDATE OF status, cliente_principal_id
ON clientes
FOR EACH ROW
EXECUTE FUNCTION kidmais_validar_cliente_principal();

CREATE TRIGGER clientes_atualizado_em_trg
BEFORE UPDATE ON clientes
FOR EACH ROW
EXECUTE FUNCTION kidmais_set_atualizado_em();

CREATE TABLE aniversariantes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    cliente_id uuid NOT NULL,
    nome text NOT NULL,
    data_nascimento date,
    tema_padrao text,
    observacoes text,
    ativo boolean NOT NULL DEFAULT true,
    desativado_em timestamptz,
    criado_por_usuario_id uuid,
    atualizado_por_usuario_id uuid,
    criado_em timestamptz NOT NULL DEFAULT now(),
    atualizado_em timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT aniversariantes_cliente_fk
        FOREIGN KEY (cliente_id)
        REFERENCES clientes(id)
        ON DELETE RESTRICT,
    CONSTRAINT aniversariantes_nome_nao_vazio CHECK (btrim(nome) <> ''),
    CONSTRAINT aniversariantes_ativo_consistencia CHECK (
        (ativo = true AND desativado_em IS NULL)
        OR
        (ativo = false AND desativado_em IS NOT NULL)
    )
);

CREATE INDEX aniversariantes_cliente_idx
    ON aniversariantes (cliente_id, ativo);

CREATE TRIGGER aniversariantes_atualizado_em_trg
BEFORE UPDATE ON aniversariantes
FOR EACH ROW
EXECUTE FUNCTION kidmais_set_atualizado_em();

CREATE TABLE responsaveis_adicionais (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    cliente_id uuid NOT NULL,
    nome text NOT NULL,
    cpf char(11),
    telefone varchar(15),
    whatsapp varchar(15),
    email text,
    relacao text,
    observacoes text,
    ativo boolean NOT NULL DEFAULT true,
    desativado_em timestamptz,
    criado_por_usuario_id uuid,
    atualizado_por_usuario_id uuid,
    criado_em timestamptz NOT NULL DEFAULT now(),
    atualizado_em timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT responsaveis_cliente_fk
        FOREIGN KEY (cliente_id)
        REFERENCES clientes(id)
        ON DELETE RESTRICT,
    CONSTRAINT responsaveis_nome_nao_vazio CHECK (btrim(nome) <> ''),
    CONSTRAINT responsaveis_cpf_formato CHECK (cpf IS NULL OR cpf ~ '^[0-9]{11}$'),
    CONSTRAINT responsaveis_telefone_formato CHECK (telefone IS NULL OR telefone ~ '^[0-9]{10,15}$'),
    CONSTRAINT responsaveis_whatsapp_formato CHECK (whatsapp IS NULL OR whatsapp ~ '^[0-9]{10,15}$'),
    CONSTRAINT responsaveis_email_nao_vazio CHECK (email IS NULL OR btrim(email) <> ''),
    CONSTRAINT responsaveis_ativo_consistencia CHECK (
        (ativo = true AND desativado_em IS NULL)
        OR
        (ativo = false AND desativado_em IS NOT NULL)
    )
);

CREATE INDEX responsaveis_cliente_idx
    ON responsaveis_adicionais (cliente_id, ativo);

CREATE INDEX responsaveis_telefone_idx
    ON responsaveis_adicionais (telefone)
    WHERE telefone IS NOT NULL;

CREATE INDEX responsaveis_whatsapp_idx
    ON responsaveis_adicionais (whatsapp)
    WHERE whatsapp IS NOT NULL;

CREATE TRIGGER responsaveis_atualizado_em_trg
BEFORE UPDATE ON responsaveis_adicionais
FOR EACH ROW
EXECUTE FUNCTION kidmais_set_atualizado_em();

COMMIT;
