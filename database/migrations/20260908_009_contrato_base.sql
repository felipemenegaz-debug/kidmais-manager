-- =============================================================================
-- Kidmais Manager
-- Migration 009 — Base persistente de Contrato
-- Arquivo: 20260908_009_contrato_base.sql
--
-- Escopo desta migration:
--   1. Completar dados contratuais que o Fechamento já coleta, mas ainda não
--      persistia (forma de pagamento pretendida, buffet, alterações, tema etc.).
--   2. Persistir RG opcional do Cliente, sem alterar a unicidade de CPF.
--   3. Criar Contrato lógico 1:1 com Fechamento.
--   4. Criar versões imutáveis de snapshot contratual.
--
-- Decisões preservadas:
--   - NÃO cria Festa.
--   - NÃO cria Pagamentos.
--   - Contrato não confirma Festa e não registra pagamento.
--   - Fechamento continua sendo a fonte do processo comercial.
--   - Contrato referencia Fechamento e congela uma versão documental.
--   - Versões anteriores não são apagadas; são marcadas como SUBSTITUIDA.
--   - schema_mvp_kidmais.sql permanece legado/provisório e NÃO é alterado.
-- =============================================================================

BEGIN;

-- =============================================================================
-- 0. PRÉ-REQUISITOS
-- =============================================================================

DO $$
BEGIN
    IF to_regclass('public.clientes') IS NULL THEN
        RAISE EXCEPTION 'Migration 009 exige a tabela clientes.';
    END IF;

    IF to_regclass('public.responsaveis_adicionais') IS NULL THEN
        RAISE EXCEPTION 'Migration 009 exige a tabela responsaveis_adicionais.';
    END IF;

    IF to_regclass('public.fechamentos') IS NULL THEN
        RAISE EXCEPTION 'Migration 009 exige a tabela fechamentos.';
    END IF;

    IF to_regclass('public.fechamento_adicionais') IS NULL THEN
        RAISE EXCEPTION 'Migration 009 exige a tabela fechamento_adicionais.';
    END IF;

    IF to_regclass('public.pacotes') IS NULL THEN
        RAISE EXCEPTION 'Migration 009 exige a tabela pacotes.';
    END IF;

    IF to_regclass('public.tabelas_preco') IS NULL THEN
        RAISE EXCEPTION 'Migration 009 exige a tabela tabelas_preco.';
    END IF;

    IF to_regclass('public.eventos_historico_cliente') IS NULL THEN
        RAISE EXCEPTION 'Migration 009 exige a tabela eventos_historico_cliente.';
    END IF;

    IF to_regclass('public.auditoria') IS NULL THEN
        RAISE EXCEPTION 'Migration 009 exige a tabela auditoria.';
    END IF;

    IF to_regprocedure('public.kidmais_set_atualizado_em()') IS NULL THEN
        RAISE EXCEPTION 'Migration 009 exige a função kidmais_set_atualizado_em().';
    END IF;

    IF to_regclass('public.contratos') IS NOT NULL
       OR to_regclass('public.contrato_versoes') IS NOT NULL THEN
        RAISE EXCEPTION 'Migration 009 detectou estrutura de Contrato já existente. Revise antes de aplicar.';
    END IF;
END;
$$;

-- =============================================================================
-- 1. CLIENTE — IDENTIFICAÇÃO CONTRATUAL OPCIONAL
-- =============================================================================

ALTER TABLE clientes
    ADD COLUMN rg varchar(30);

ALTER TABLE clientes
    ADD CONSTRAINT clientes_rg_nao_vazio
    CHECK (rg IS NULL OR btrim(rg) <> '');

COMMENT ON COLUMN clientes.rg IS
'RG/documento estadual informado pelo Cliente. Opcional no cadastro; preservado em snapshots contratuais quando disponível.';

-- =============================================================================
-- 2. FECHAMENTO — DADOS ESPECÍFICOS DA CONTRATAÇÃO
-- =============================================================================

ALTER TABLE fechamentos
    ADD COLUMN responsavel_adicional_id uuid,
    ADD COLUMN idade_aniversariante_evento smallint,
    ADD COLUMN tema_festa text,
    ADD COLUMN forma_pagamento_pretendida varchar(30),
    ADD COLUMN alteracoes_pacote text,
    ADD COLUMN observacoes_cliente text,
    ADD COLUMN buffet_salgados text,
    ADD COLUMN buffet_bebidas text,
    ADD COLUMN buffet_doces text,
    ADD COLUMN buffet_bolo text,
    ADD COLUMN buffet_outros text;

ALTER TABLE fechamentos
    ADD CONSTRAINT fechamentos_responsavel_adicional_fk
        FOREIGN KEY (responsavel_adicional_id)
        REFERENCES responsaveis_adicionais(id)
        ON DELETE RESTRICT,
    ADD CONSTRAINT fechamentos_idade_aniversariante_evento_check
        CHECK (
            idade_aniversariante_evento IS NULL
            OR idade_aniversariante_evento BETWEEN 0 AND 120
        ),
    ADD CONSTRAINT fechamentos_forma_pagamento_pretendida_check
        CHECK (
            forma_pagamento_pretendida IS NULL
            OR forma_pagamento_pretendida IN (
                'PIX_AVISTA',
                'PIX_PARCELADO',
                'CARTAO_CIELO'
            )
        );

CREATE INDEX fechamentos_responsavel_adicional_idx
    ON fechamentos (responsavel_adicional_id)
    WHERE responsavel_adicional_id IS NOT NULL;

COMMENT ON COLUMN fechamentos.responsavel_adicional_id IS
'Responsável adicional escolhido/criado para esta contratação. Não substitui o Cliente contratante.';

COMMENT ON COLUMN fechamentos.forma_pagamento_pretendida IS
'Preferência informada no Fechamento. Não representa pagamento efetuado nem condição financeira quitada.';

COMMENT ON COLUMN fechamentos.alteracoes_pacote IS
'Ajustes específicos desta contratação; nunca altera o pacote mestre.';

-- =============================================================================
-- 3. CONTRATO LÓGICO
-- =============================================================================

CREATE TABLE contratos (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    fechamento_id uuid NOT NULL,
    status varchar(30) NOT NULL DEFAULT 'AGUARDANDO_ASSINATURA',
    versao_atual integer NOT NULL DEFAULT 0,

    criado_por_usuario_id uuid,
    assinado_em timestamptz,
    cancelado_em timestamptz,
    criado_em timestamptz NOT NULL DEFAULT now(),
    atualizado_em timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT contratos_fechamento_fk
        FOREIGN KEY (fechamento_id)
        REFERENCES fechamentos(id)
        ON DELETE RESTRICT,

    CONSTRAINT contratos_fechamento_uk UNIQUE (fechamento_id),

    CONSTRAINT contratos_status_check CHECK (
        status IN ('AGUARDANDO_ASSINATURA', 'ASSINADO', 'CANCELADO')
    ),

    CONSTRAINT contratos_versao_atual_check CHECK (
        versao_atual >= 0
    ),

    CONSTRAINT contratos_assinatura_consistencia_check CHECK (
        status <> 'ASSINADO' OR assinado_em IS NOT NULL
    ),

    CONSTRAINT contratos_cancelamento_consistencia_check CHECK (
        status <> 'CANCELADO' OR cancelado_em IS NOT NULL
    )
);

CREATE INDEX contratos_status_idx
    ON contratos (status, criado_em DESC);

CREATE TRIGGER contratos_atualizado_em_trg
BEFORE UPDATE ON contratos
FOR EACH ROW
EXECUTE FUNCTION kidmais_set_atualizado_em();

COMMENT ON TABLE contratos IS
'Contrato lógico vinculado 1:1 ao Fechamento. O conteúdo documental fica versionado em contrato_versoes.';

-- =============================================================================
-- 4. VERSÕES / SNAPSHOTS IMUTÁVEIS
-- =============================================================================

CREATE TABLE contrato_versoes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    contrato_id uuid NOT NULL,
    numero_versao integer NOT NULL,
    status varchar(20) NOT NULL DEFAULT 'ATIVA',

    snapshot_schema_versao integer NOT NULL DEFAULT 1,
    snapshot jsonb NOT NULL,
    snapshot_hash char(64) NOT NULL,

    motivo_nova_versao text,
    gerado_por_usuario_id uuid,
    criado_em timestamptz NOT NULL DEFAULT now(),
    substituido_em timestamptz,
    assinado_em timestamptz,

    CONSTRAINT contrato_versoes_contrato_fk
        FOREIGN KEY (contrato_id)
        REFERENCES contratos(id)
        ON DELETE RESTRICT,

    CONSTRAINT contrato_versoes_numero_uk UNIQUE (contrato_id, numero_versao),

    CONSTRAINT contrato_versoes_numero_check CHECK (numero_versao > 0),

    CONSTRAINT contrato_versoes_status_check CHECK (
        status IN ('ATIVA', 'SUBSTITUIDA', 'ASSINADA', 'CANCELADA')
    ),

    CONSTRAINT contrato_versoes_snapshot_schema_check CHECK (
        snapshot_schema_versao > 0
    ),

    CONSTRAINT contrato_versoes_snapshot_objeto_check CHECK (
        jsonb_typeof(snapshot) = 'object'
    ),

    CONSTRAINT contrato_versoes_snapshot_hash_check CHECK (
        snapshot_hash ~ '^[0-9a-f]{64}$'
    ),

    CONSTRAINT contrato_versoes_substituicao_consistencia_check CHECK (
        status <> 'SUBSTITUIDA' OR substituido_em IS NOT NULL
    ),

    CONSTRAINT contrato_versoes_assinatura_consistencia_check CHECK (
        status <> 'ASSINADA' OR assinado_em IS NOT NULL
    )
);

-- Só pode existir uma versão documental corrente por Contrato.
CREATE UNIQUE INDEX contrato_versoes_corrente_uk
    ON contrato_versoes (contrato_id)
    WHERE status IN ('ATIVA', 'ASSINADA');

CREATE INDEX contrato_versoes_contrato_idx
    ON contrato_versoes (contrato_id, numero_versao DESC);

CREATE INDEX contrato_versoes_hash_idx
    ON contrato_versoes (snapshot_hash);

COMMENT ON TABLE contrato_versoes IS
'Versões imutáveis do conteúdo contratual. Nova geração substitui a versão ATIVA anterior sem apagá-la.';

COMMENT ON COLUMN contrato_versoes.snapshot_hash IS
'SHA-256 hexadecimal do snapshot canônico usado para detectar regenerações idempotentes e apoiar integridade futura.';

COMMIT;
