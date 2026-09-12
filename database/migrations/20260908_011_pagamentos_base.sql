-- =============================================================================
-- Kidmais Manager
-- Migration 011 — Núcleo persistente de Pagamentos
-- Arquivo: 20260908_011_pagamentos_base.sql
--
-- Escopo desta migration:
--   1. Obrigação financeira vinculada à versão CONTRATUAL ASSINADA.
--   2. Planos de pagamento versionados e parcelas.
--   3. Recebimentos e alocação por parcela.
--   4. Estornos preservando o recebimento original.
--   5. Metadados de comprovantes, sem acoplar armazenamento físico.
--
-- Decisões preservadas:
--   - Pagamentos NÃO recalcula preço comercial.
--   - valor_total_contratado é copiado do snapshot da versão assinada pelo serviço.
--   - forma_pagamento_pretendida do Fechamento continua sendo apenas intenção.
--   - Pagamentos referencia contrato_versoes; Fechamento é alcançado por Contrato.
--   - Um recebimento pode ser distribuído entre parcelas por alocações.
--   - Estorno nunca apaga nem altera o recebimento original.
--   - Não existe integração física com PIX/Cielo nesta migration.
--   - IDs de provedor são metadados genéricos para adapters futuros.
--   - Festa NÃO é criada nem alterada.
--   - schema_mvp_kidmais.sql permanece legado/provisório e NÃO é alterado.
-- =============================================================================

BEGIN;

-- =============================================================================
-- 0. PRÉ-REQUISITOS / PROTEÇÃO CONTRA APLICAÇÃO ACIDENTAL
-- =============================================================================

DO $$
BEGIN
    IF to_regclass('public.fechamentos') IS NULL THEN
        RAISE EXCEPTION 'Migration 011 exige a tabela fechamentos.';
    END IF;

    IF to_regclass('public.contratos') IS NULL THEN
        RAISE EXCEPTION 'Migration 011 exige a tabela contratos.';
    END IF;

    IF to_regclass('public.contrato_versoes') IS NULL THEN
        RAISE EXCEPTION 'Migration 011 exige a tabela contrato_versoes.';
    END IF;

    IF to_regclass('public.eventos_historico_cliente') IS NULL THEN
        RAISE EXCEPTION 'Migration 011 exige a tabela eventos_historico_cliente.';
    END IF;

    IF to_regclass('public.auditoria') IS NULL THEN
        RAISE EXCEPTION 'Migration 011 exige a tabela auditoria.';
    END IF;

    IF to_regclass('public.bloqueios_agenda') IS NULL THEN
        RAISE EXCEPTION 'Migration 011 exige a tabela bloqueios_agenda.';
    END IF;

    IF to_regprocedure('public.kidmais_set_atualizado_em()') IS NULL THEN
        RAISE EXCEPTION 'Migration 011 exige a função kidmais_set_atualizado_em().';
    END IF;

    IF to_regclass('public.pagamentos') IS NOT NULL
       OR to_regclass('public.pagamento_planos') IS NOT NULL
       OR to_regclass('public.pagamento_parcelas') IS NOT NULL
       OR to_regclass('public.pagamento_recebimentos') IS NOT NULL
       OR to_regclass('public.pagamento_recebimento_alocacoes') IS NOT NULL
       OR to_regclass('public.pagamento_estornos') IS NOT NULL
       OR to_regclass('public.pagamento_comprovantes') IS NOT NULL
       OR to_regclass('public.parcelas') IS NOT NULL
       OR to_regclass('public.taxas_cartao') IS NOT NULL THEN
        RAISE EXCEPTION 'Migration 011 detectou estrutura de Pagamentos atual ou legado financeiro. Revise antes de aplicar.';
    END IF;
END;
$$;

-- =============================================================================
-- 1. PAGAMENTO — OBRIGAÇÃO FINANCEIRA DO CONTRATO ASSINADO
-- =============================================================================

CREATE TABLE pagamentos (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    contrato_versao_id uuid NOT NULL,

    valor_total_contratado numeric(12,2) NOT NULL,
    moeda char(3) NOT NULL DEFAULT 'BRL',

    status varchar(30) NOT NULL DEFAULT 'AGUARDANDO_PAGAMENTO',

    -- Reserva é uma consequência do pagamento qualificador, mas é registrada
    -- separadamente do status financeiro. Estorno posterior NÃO desfaz a reserva
    -- silenciosamente.
    reserva_status varchar(20) NOT NULL DEFAULT 'PENDENTE',
    reserva_confirmada_em timestamptz,
    reserva_conflito_em timestamptz,

    quitado_em timestamptz,
    cancelado_em timestamptz,
    criado_por_usuario_id uuid,

    criado_em timestamptz NOT NULL DEFAULT now(),
    atualizado_em timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT pagamentos_contrato_versao_fk
        FOREIGN KEY (contrato_versao_id)
        REFERENCES contrato_versoes(id)
        ON DELETE RESTRICT,

    CONSTRAINT pagamentos_contrato_versao_uk UNIQUE (contrato_versao_id),

    CONSTRAINT pagamentos_valor_total_check CHECK (valor_total_contratado > 0),

    CONSTRAINT pagamentos_moeda_check CHECK (moeda = 'BRL'),

    CONSTRAINT pagamentos_status_check CHECK (
        status IN (
            'AGUARDANDO_PAGAMENTO',
            'PARCIALMENTE_PAGO',
            'QUITADO',
            'ESTORNADO',
            'CANCELADO'
        )
    ),

    CONSTRAINT pagamentos_reserva_status_check CHECK (
        reserva_status IN ('PENDENTE', 'CONFIRMADA', 'CONFLITO')
    ),

    CONSTRAINT pagamentos_reserva_confirmada_check CHECK (
        reserva_status <> 'CONFIRMADA' OR reserva_confirmada_em IS NOT NULL
    ),

    CONSTRAINT pagamentos_reserva_conflito_check CHECK (
        reserva_status <> 'CONFLITO' OR reserva_conflito_em IS NOT NULL
    ),

    CONSTRAINT pagamentos_quitacao_check CHECK (
        status <> 'QUITADO' OR quitado_em IS NOT NULL
    ),

    CONSTRAINT pagamentos_cancelamento_check CHECK (
        status <> 'CANCELADO' OR cancelado_em IS NOT NULL
    )
);

CREATE INDEX pagamentos_status_idx
    ON pagamentos (status, criado_em DESC);

CREATE INDEX pagamentos_reserva_status_idx
    ON pagamentos (reserva_status, criado_em DESC);

CREATE TRIGGER pagamentos_atualizado_em_trg
BEFORE UPDATE ON pagamentos
FOR EACH ROW
EXECUTE FUNCTION kidmais_set_atualizado_em();

COMMENT ON TABLE pagamentos IS
'Obrigação financeira de uma versão contratual assinada. Não é fonte de preço comercial e não cria Festa.';

COMMENT ON COLUMN pagamentos.valor_total_contratado IS
'Valor congelado pelo serviço a partir de contrato_versoes.snapshot.comercial.valorFinalContrato.';

COMMENT ON COLUMN pagamentos.reserva_status IS
'Estado da confirmação de agenda decorrente do pagamento qualificador. É independente do status financeiro.';

-- =============================================================================
-- 2. PLANOS DE PAGAMENTO VERSIONADOS
-- =============================================================================

CREATE TABLE pagamento_planos (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    pagamento_id uuid NOT NULL,
    numero_versao integer NOT NULL,
    status varchar(20) NOT NULL DEFAULT 'ATIVO',

    meio_pagamento varchar(20) NOT NULL,
    modalidade varchar(20) NOT NULL,
    quantidade_parcelas smallint NOT NULL,

    -- Preferência de infraestrutura/adquirente. O núcleo não depende dela.
    provedor_preferido varchar(50),
    observacoes text,
    motivo_substituicao text,
    criado_por_usuario_id uuid,

    criado_em timestamptz NOT NULL DEFAULT now(),
    substituido_em timestamptz,
    cancelado_em timestamptz,

    CONSTRAINT pagamento_planos_pagamento_fk
        FOREIGN KEY (pagamento_id)
        REFERENCES pagamentos(id)
        ON DELETE RESTRICT,

    CONSTRAINT pagamento_planos_numero_uk UNIQUE (pagamento_id, numero_versao),

    CONSTRAINT pagamento_planos_numero_check CHECK (numero_versao > 0),

    CONSTRAINT pagamento_planos_status_check CHECK (
        status IN ('ATIVO', 'SUBSTITUIDO', 'CANCELADO')
    ),

    CONSTRAINT pagamento_planos_meio_check CHECK (
        meio_pagamento IN ('PIX', 'CARTAO')
    ),

    CONSTRAINT pagamento_planos_modalidade_check CHECK (
        modalidade IN ('AVISTA', 'PARCELADO')
    ),

    CONSTRAINT pagamento_planos_quantidade_check CHECK (
        quantidade_parcelas BETWEEN 1 AND 60
    ),

    CONSTRAINT pagamento_planos_modalidade_quantidade_check CHECK (
        (modalidade = 'AVISTA' AND quantidade_parcelas = 1)
        OR
        (modalidade = 'PARCELADO' AND quantidade_parcelas >= 2)
    ),

    CONSTRAINT pagamento_planos_provedor_nao_vazio_check CHECK (
        provedor_preferido IS NULL OR btrim(provedor_preferido) <> ''
    ),

    CONSTRAINT pagamento_planos_substituicao_check CHECK (
        status <> 'SUBSTITUIDO' OR substituido_em IS NOT NULL
    ),

    CONSTRAINT pagamento_planos_cancelamento_check CHECK (
        status <> 'CANCELADO' OR cancelado_em IS NOT NULL
    )
);

CREATE UNIQUE INDEX pagamento_planos_ativo_uk
    ON pagamento_planos (pagamento_id)
    WHERE status = 'ATIVO';

CREATE INDEX pagamento_planos_pagamento_idx
    ON pagamento_planos (pagamento_id, numero_versao DESC);

COMMENT ON TABLE pagamento_planos IS
'Condição efetivamente escolhida para cobrança. Alterações geram nova versão; a versão anterior é preservada.';

-- =============================================================================
-- 3. PARCELAS
-- =============================================================================

CREATE TABLE pagamento_parcelas (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    plano_id uuid NOT NULL,
    numero smallint NOT NULL,
    valor_previsto numeric(12,2) NOT NULL,
    vencimento date NOT NULL,
    confirma_reserva boolean NOT NULL DEFAULT false,
    status varchar(30) NOT NULL DEFAULT 'PENDENTE',

    criado_em timestamptz NOT NULL DEFAULT now(),
    atualizado_em timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT pagamento_parcelas_plano_fk
        FOREIGN KEY (plano_id)
        REFERENCES pagamento_planos(id)
        ON DELETE RESTRICT,

    CONSTRAINT pagamento_parcelas_numero_uk UNIQUE (plano_id, numero),

    CONSTRAINT pagamento_parcelas_numero_check CHECK (numero > 0),

    CONSTRAINT pagamento_parcelas_valor_check CHECK (valor_previsto > 0),

    CONSTRAINT pagamento_parcelas_status_check CHECK (
        status IN (
            'PENDENTE',
            'PARCIALMENTE_PAGA',
            'PAGA',
            'ESTORNADA',
            'CANCELADA'
        )
    )
);

CREATE UNIQUE INDEX pagamento_parcelas_confirma_reserva_uk
    ON pagamento_parcelas (plano_id)
    WHERE confirma_reserva = true;

CREATE INDEX pagamento_parcelas_vencimento_idx
    ON pagamento_parcelas (vencimento, status);

CREATE TRIGGER pagamento_parcelas_atualizado_em_trg
BEFORE UPDATE ON pagamento_parcelas
FOR EACH ROW
EXECUTE FUNCTION kidmais_set_atualizado_em();

COMMENT ON COLUMN pagamento_parcelas.confirma_reserva IS
'Parcela cuja quitação líquida permite tentar confirmar a agenda. Deve existir exatamente uma no plano ativo; o serviço garante essa regra.';

-- =============================================================================
-- 4. RECEBIMENTOS — MOVIMENTOS DE ENTRADA
-- =============================================================================

CREATE TABLE pagamento_recebimentos (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    pagamento_id uuid NOT NULL,

    status varchar(20) NOT NULL DEFAULT 'PENDENTE',
    meio_pagamento varchar(20) NOT NULL,
    valor_bruto numeric(12,2) NOT NULL,

    recebido_em timestamptz NOT NULL DEFAULT now(),
    confirmado_em timestamptz,
    cancelado_em timestamptz,

    provedor_codigo varchar(50),
    referencia_externa varchar(160),
    chave_idempotencia varchar(160),
    metadata_provedor jsonb NOT NULL DEFAULT '{}'::jsonb,

    registrado_por_usuario_id uuid,
    observacoes text,

    criado_em timestamptz NOT NULL DEFAULT now(),
    atualizado_em timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT pagamento_recebimentos_pagamento_fk
        FOREIGN KEY (pagamento_id)
        REFERENCES pagamentos(id)
        ON DELETE RESTRICT,

    CONSTRAINT pagamento_recebimentos_status_check CHECK (
        status IN ('PENDENTE', 'CONFIRMADO', 'RECUSADO', 'CANCELADO')
    ),

    CONSTRAINT pagamento_recebimentos_meio_check CHECK (
        meio_pagamento IN ('PIX', 'CARTAO', 'TRANSFERENCIA', 'DINHEIRO', 'OUTRO')
    ),

    CONSTRAINT pagamento_recebimentos_valor_check CHECK (valor_bruto > 0),

    CONSTRAINT pagamento_recebimentos_metadata_check CHECK (
        jsonb_typeof(metadata_provedor) = 'object'
    ),

    CONSTRAINT pagamento_recebimentos_confirmacao_check CHECK (
        status <> 'CONFIRMADO' OR confirmado_em IS NOT NULL
    ),

    CONSTRAINT pagamento_recebimentos_cancelamento_check CHECK (
        status <> 'CANCELADO' OR cancelado_em IS NOT NULL
    )
);

CREATE UNIQUE INDEX pagamento_recebimentos_idempotencia_uk
    ON pagamento_recebimentos (chave_idempotencia)
    WHERE chave_idempotencia IS NOT NULL;

CREATE UNIQUE INDEX pagamento_recebimentos_referencia_provedor_uk
    ON pagamento_recebimentos (provedor_codigo, referencia_externa)
    WHERE provedor_codigo IS NOT NULL
      AND referencia_externa IS NOT NULL;

CREATE INDEX pagamento_recebimentos_pagamento_idx
    ON pagamento_recebimentos (pagamento_id, recebido_em DESC);

CREATE TRIGGER pagamento_recebimentos_atualizado_em_trg
BEFORE UPDATE ON pagamento_recebimentos
FOR EACH ROW
EXECUTE FUNCTION kidmais_set_atualizado_em();

COMMENT ON TABLE pagamento_recebimentos IS
'Movimentos de entrada. Pode representar baixa manual ou transação de um provedor futuro sem acoplamento ao provedor.';

-- =============================================================================
-- 5. ALOCAÇÕES — UM RECEBIMENTO PODE QUITAR UMA OU MAIS PARCELAS
-- =============================================================================

CREATE TABLE pagamento_recebimento_alocacoes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    recebimento_id uuid NOT NULL,
    parcela_id uuid NOT NULL,
    valor_alocado numeric(12,2) NOT NULL,
    criado_em timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT pagamento_alocacoes_recebimento_fk
        FOREIGN KEY (recebimento_id)
        REFERENCES pagamento_recebimentos(id)
        ON DELETE RESTRICT,

    CONSTRAINT pagamento_alocacoes_parcela_fk
        FOREIGN KEY (parcela_id)
        REFERENCES pagamento_parcelas(id)
        ON DELETE RESTRICT,

    CONSTRAINT pagamento_alocacoes_recebimento_parcela_uk
        UNIQUE (recebimento_id, parcela_id),

    CONSTRAINT pagamento_alocacoes_valor_check CHECK (valor_alocado > 0)
);

CREATE INDEX pagamento_alocacoes_parcela_idx
    ON pagamento_recebimento_alocacoes (parcela_id);

COMMENT ON TABLE pagamento_recebimento_alocacoes IS
'Distribuição imutável do valor de um recebimento entre parcelas do plano ativo no momento da criação.';

-- =============================================================================
-- 6. ESTORNOS
-- =============================================================================

CREATE TABLE pagamento_estornos (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    recebimento_id uuid NOT NULL,
    parcela_id uuid NOT NULL,
    valor numeric(12,2) NOT NULL,
    status varchar(20) NOT NULL DEFAULT 'SOLICITADO',

    motivo text,
    solicitado_em timestamptz NOT NULL DEFAULT now(),
    confirmado_em timestamptz,
    cancelado_em timestamptz,

    provedor_codigo varchar(50),
    referencia_externa varchar(160),
    chave_idempotencia varchar(160),
    metadata_provedor jsonb NOT NULL DEFAULT '{}'::jsonb,
    registrado_por_usuario_id uuid,

    criado_em timestamptz NOT NULL DEFAULT now(),
    atualizado_em timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT pagamento_estornos_recebimento_fk
        FOREIGN KEY (recebimento_id)
        REFERENCES pagamento_recebimentos(id)
        ON DELETE RESTRICT,

    CONSTRAINT pagamento_estornos_parcela_fk
        FOREIGN KEY (parcela_id)
        REFERENCES pagamento_parcelas(id)
        ON DELETE RESTRICT,

    CONSTRAINT pagamento_estornos_valor_check CHECK (valor > 0),

    CONSTRAINT pagamento_estornos_status_check CHECK (
        status IN ('SOLICITADO', 'CONFIRMADO', 'FALHOU', 'CANCELADO')
    ),

    CONSTRAINT pagamento_estornos_metadata_check CHECK (
        jsonb_typeof(metadata_provedor) = 'object'
    ),

    CONSTRAINT pagamento_estornos_confirmacao_check CHECK (
        status <> 'CONFIRMADO' OR confirmado_em IS NOT NULL
    ),

    CONSTRAINT pagamento_estornos_cancelamento_check CHECK (
        status <> 'CANCELADO' OR cancelado_em IS NOT NULL
    )
);

CREATE UNIQUE INDEX pagamento_estornos_idempotencia_uk
    ON pagamento_estornos (chave_idempotencia)
    WHERE chave_idempotencia IS NOT NULL;

CREATE UNIQUE INDEX pagamento_estornos_referencia_provedor_uk
    ON pagamento_estornos (provedor_codigo, referencia_externa)
    WHERE provedor_codigo IS NOT NULL
      AND referencia_externa IS NOT NULL;

CREATE INDEX pagamento_estornos_recebimento_idx
    ON pagamento_estornos (recebimento_id, solicitado_em DESC);

CREATE INDEX pagamento_estornos_parcela_idx
    ON pagamento_estornos (parcela_id, solicitado_em DESC);

CREATE TRIGGER pagamento_estornos_atualizado_em_trg
BEFORE UPDATE ON pagamento_estornos
FOR EACH ROW
EXECUTE FUNCTION kidmais_set_atualizado_em();

COMMENT ON TABLE pagamento_estornos IS
'Estornos preservam o recebimento original. O efeito financeiro líquido é calculado a partir dos estornos CONFIRMADOS.';

-- =============================================================================
-- 7. COMPROVANTES — SOMENTE METADADOS / INTEGRIDADE
-- =============================================================================

CREATE TABLE pagamento_comprovantes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    recebimento_id uuid NOT NULL,

    nome_arquivo varchar(255) NOT NULL,
    mime_type varchar(120) NOT NULL,
    tamanho_bytes bigint NOT NULL,
    sha256 char(64) NOT NULL,
    localizador_arquivo text NOT NULL,

    registrado_por_usuario_id uuid,
    criado_em timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT pagamento_comprovantes_recebimento_fk
        FOREIGN KEY (recebimento_id)
        REFERENCES pagamento_recebimentos(id)
        ON DELETE RESTRICT,

    CONSTRAINT pagamento_comprovantes_nome_check CHECK (btrim(nome_arquivo) <> ''),
    CONSTRAINT pagamento_comprovantes_mime_check CHECK (btrim(mime_type) <> ''),
    CONSTRAINT pagamento_comprovantes_tamanho_check CHECK (tamanho_bytes > 0),
    CONSTRAINT pagamento_comprovantes_sha256_check CHECK (
        sha256 ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT pagamento_comprovantes_localizador_check CHECK (
        btrim(localizador_arquivo) <> ''
    ),

    CONSTRAINT pagamento_comprovantes_recebimento_hash_uk
        UNIQUE (recebimento_id, sha256)
);

CREATE INDEX pagamento_comprovantes_recebimento_idx
    ON pagamento_comprovantes (recebimento_id, criado_em DESC);

COMMENT ON TABLE pagamento_comprovantes IS
'Metadados e SHA-256 de comprovantes. O arquivo físico fica fora do banco e poderá usar storage adapter futuro.';

COMMIT;
