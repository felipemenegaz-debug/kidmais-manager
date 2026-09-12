-- =============================================================================
-- Kidmais Manager
-- Migration 008 — Identidade pública / validação de Cliente
-- Arquivo: 20260908_008_identidade_cliente.sql
--
-- Escopo desta migration:
--   1. Criar a persistência dos desafios de validação de identidade.
--   2. Permitir validar Cliente existente sem expor cliente_id como prova.
--   3. Permitir prova de identidade temporária e de uso único.
--   4. Registrar recuperação pendente quando o Cliente não possui acesso
--      ao contato cadastrado.
--
-- Decisões preservadas:
--   - NÃO recria nem altera clientes.
--   - NÃO recria nem altera aniversariantes.
--   - NÃO altera o UNIQUE físico de CPF.
--   - NÃO altera as FKs já existentes em fechamentos.
--   - NÃO implementa autenticação de usuários internos.
--   - ATENDIMENTO_KIDMAIS continua dependendo de contexto interno confiável.
--   - Nenhum OTP é armazenado em texto puro.
--   - Nenhum token de prova é armazenado em texto puro.
--   - Dados pessoais completos não são copiados para esta tabela.
--   - schema_mvp_kidmais.sql permanece legado/provisório.
-- =============================================================================

BEGIN;

-- =============================================================================
-- 0. PRÉ-REQUISITOS
-- =============================================================================

DO $$
BEGIN
    IF to_regclass('public.clientes') IS NULL THEN
        RAISE EXCEPTION 'Migration 008 exige a tabela clientes.';
    END IF;

    IF to_regclass('public.fechamentos') IS NULL THEN
        RAISE EXCEPTION 'Migration 008 exige a tabela fechamentos.';
    END IF;

    IF to_regprocedure('public.kidmais_set_atualizado_em()') IS NULL THEN
        RAISE EXCEPTION
            'Migration 008 exige a função kidmais_set_atualizado_em().';
    END IF;
END;
$$;

-- =============================================================================
-- 1. VALIDAÇÕES DE IDENTIDADE
-- =============================================================================

CREATE TABLE validacoes_identidade_cliente (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Sempre aponta para o Cliente canônico identificado pelo backend.
    -- Este ID não deve ser usado pelo navegador como prova de identidade.
    cliente_id uuid NOT NULL,

    -- Nesta etapa existe somente a finalidade pública de Fechamento.
    finalidade varchar(30) NOT NULL DEFAULT 'FECHAMENTO_PUBLICO',

    -- Canal efetivamente usado para o desafio.
    -- TELEFONE do CRM poderá originar SMS na futura integração do provedor.
    canal varchar(20),

    status varchar(30) NOT NULL DEFAULT 'PENDENTE',

    -- O código OTP nunca é persistido em texto puro.
    -- A aplicação armazenará somente representação criptográfica segura.
    codigo_hash text,

    tentativas smallint NOT NULL DEFAULT 0,
    max_tentativas smallint NOT NULL DEFAULT 5,

    envios smallint NOT NULL DEFAULT 0,
    max_envios smallint NOT NULL DEFAULT 3,
    ultimo_envio_em timestamptz,

    codigo_expira_em timestamptz,

    -- Após validar o OTP, o backend gera uma prova aleatória temporária.
    confirmado_em timestamptz,
    token_prova_hash text,
    prova_expira_em timestamptz,

    -- A prova deve ser consumida uma única vez ao vincular o Fechamento.
    consumido_em timestamptz,
    consumido_por_fechamento_id uuid,

    -- Quando o Cliente reconhece o CPF, mas não possui acesso ao contato
    -- antigo, não é criado outro Cliente automaticamente.
    recuperacao_solicitada_em timestamptz,

    criado_em timestamptz NOT NULL DEFAULT now(),
    atualizado_em timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT validacoes_identidade_cliente_cliente_fk
        FOREIGN KEY (cliente_id)
        REFERENCES clientes(id)
        ON DELETE RESTRICT,

    CONSTRAINT validacoes_identidade_cliente_fechamento_fk
        FOREIGN KEY (consumido_por_fechamento_id)
        REFERENCES fechamentos(id)
        ON DELETE RESTRICT,

    CONSTRAINT validacoes_identidade_cliente_finalidade_check CHECK (
        finalidade IN ('FECHAMENTO_PUBLICO')
    ),

    CONSTRAINT validacoes_identidade_cliente_canal_check CHECK (
        canal IS NULL
        OR canal IN ('WHATSAPP', 'SMS', 'EMAIL')
    ),

    CONSTRAINT validacoes_identidade_cliente_status_check CHECK (
        status IN (
            'PENDENTE',
            'CONFIRMADA',
            'CONSUMIDA',
            'RECUPERACAO_PENDENTE',
            'EXPIRADA',
            'BLOQUEADA',
            'CANCELADA'
        )
    ),

    CONSTRAINT validacoes_identidade_cliente_tentativas_check CHECK (
        tentativas >= 0
        AND max_tentativas > 0
        AND tentativas <= max_tentativas
    ),

    CONSTRAINT validacoes_identidade_cliente_envios_check CHECK (
        envios >= 0
        AND max_envios > 0
        AND envios <= max_envios
    ),

    CONSTRAINT validacoes_identidade_cliente_codigo_expiracao_check CHECK (
        codigo_expira_em IS NULL
        OR codigo_expira_em > criado_em
    ),

    CONSTRAINT validacoes_identidade_cliente_prova_expiracao_check CHECK (
        prova_expira_em IS NULL
        OR confirmado_em IS NULL
        OR prova_expira_em > confirmado_em
    ),

    -- Um desafio OTP pendente precisa possuir canal, hash e expiração.
    CONSTRAINT validacoes_identidade_cliente_pendente_check CHECK (
        status <> 'PENDENTE'
        OR (
            canal IS NOT NULL
            AND codigo_hash IS NOT NULL
            AND codigo_expira_em IS NOT NULL
            AND confirmado_em IS NULL
            AND token_prova_hash IS NULL
            AND prova_expira_em IS NULL
            AND consumido_em IS NULL
            AND consumido_por_fechamento_id IS NULL
            AND recuperacao_solicitada_em IS NULL
        )
    ),

    -- Recuperação não cria OTP/prova e não vincula Cliente novo.
    CONSTRAINT validacoes_identidade_cliente_recuperacao_check CHECK (
        status <> 'RECUPERACAO_PENDENTE'
        OR (
            codigo_hash IS NULL
            AND codigo_expira_em IS NULL
            AND confirmado_em IS NULL
            AND token_prova_hash IS NULL
            AND prova_expira_em IS NULL
            AND consumido_em IS NULL
            AND consumido_por_fechamento_id IS NULL
            AND recuperacao_solicitada_em IS NOT NULL
        )
    ),

    -- Uma identidade confirmada precisa possuir uma prova temporária,
    -- mas essa prova ainda não pode ter sido consumida.
    CONSTRAINT validacoes_identidade_cliente_confirmada_check CHECK (
        status <> 'CONFIRMADA'
        OR (
            canal IS NOT NULL
            AND confirmado_em IS NOT NULL
            AND token_prova_hash IS NOT NULL
            AND prova_expira_em IS NOT NULL
            AND consumido_em IS NULL
            AND consumido_por_fechamento_id IS NULL
        )
    ),

    -- Uma prova consumida deve estar vinculada ao Fechamento criado.
    CONSTRAINT validacoes_identidade_cliente_consumida_check CHECK (
        status <> 'CONSUMIDA'
        OR (
            confirmado_em IS NOT NULL
            AND token_prova_hash IS NOT NULL
            AND prova_expira_em IS NOT NULL
            AND consumido_em IS NOT NULL
            AND consumido_por_fechamento_id IS NOT NULL
        )
    ),

    -- Data de consumo e Fechamento consumidor sempre aparecem juntos.
    CONSTRAINT validacoes_identidade_cliente_consumo_consistencia CHECK (
        (
            consumido_em IS NULL
            AND consumido_por_fechamento_id IS NULL
        )
        OR
        (
            consumido_em IS NOT NULL
            AND consumido_por_fechamento_id IS NOT NULL
        )
    )
);

-- =============================================================================
-- 2. ÍNDICES
-- =============================================================================

-- Busca do histórico/desafio mais recente de determinado Cliente.
CREATE INDEX validacoes_identidade_cliente_cliente_status_idx
    ON validacoes_identidade_cliente (
        cliente_id,
        finalidade,
        status,
        criado_em DESC
    );

-- A prova é aleatória e única. O backend procurará pelo HASH,
-- nunca pelo token puro.
CREATE UNIQUE INDEX validacoes_identidade_cliente_token_prova_uk
    ON validacoes_identidade_cliente (token_prova_hash)
    WHERE token_prova_hash IS NOT NULL;

-- Apoia expiração/limpeza de desafios OTP pendentes.
CREATE INDEX validacoes_identidade_cliente_codigo_expiracao_idx
    ON validacoes_identidade_cliente (codigo_expira_em)
    WHERE status = 'PENDENTE';

-- Apoia expiração/limpeza das provas já confirmadas.
CREATE INDEX validacoes_identidade_cliente_prova_expiracao_idx
    ON validacoes_identidade_cliente (prova_expira_em)
    WHERE status = 'CONFIRMADA';

-- =============================================================================
-- 3. ATUALIZADO_EM
-- =============================================================================

CREATE TRIGGER validacoes_identidade_cliente_atualizado_em_trg
BEFORE UPDATE ON validacoes_identidade_cliente
FOR EACH ROW
EXECUTE FUNCTION kidmais_set_atualizado_em();

COMMIT;