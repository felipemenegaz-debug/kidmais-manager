-- ============================================================
-- KIDMAIS MANAGER — SCHEMA MVP
-- PostgreSQL
-- Versão: 0.1
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- Função genérica para atualizar updated_at
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 1. USUÁRIOS
-- ============================================================
CREATE TABLE usuarios (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    nome                VARCHAR(150) NOT NULL,
    email               VARCHAR(255) NOT NULL,
    senha_hash          TEXT NOT NULL,
    perfil              VARCHAR(30) NOT NULL
                        CHECK (perfil IN ('administrador', 'atendimento', 'financeiro')),
    ativo               BOOLEAN NOT NULL DEFAULT TRUE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX ux_usuarios_email
    ON usuarios (LOWER(email));

CREATE TRIGGER trg_usuarios_updated_at
BEFORE UPDATE ON usuarios
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- 2. CLIENTES
-- ============================================================
CREATE TABLE clientes (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    nome_completo       VARCHAR(180) NOT NULL,
    cpf                 VARCHAR(14),
    telefone            VARCHAR(30),
    whatsapp            VARCHAR(30),
    email               VARCHAR(255),
    cep                 VARCHAR(9),
    logradouro          VARCHAR(180),
    numero              VARCHAR(30),
    complemento         VARCHAR(120),
    bairro              VARCHAR(120),
    cidade              VARCHAR(120),
    uf                  CHAR(2),
    observacoes         TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX ux_clientes_cpf
    ON clientes (cpf)
    WHERE cpf IS NOT NULL;

CREATE INDEX ix_clientes_nome
    ON clientes (nome_completo);

CREATE INDEX ix_clientes_whatsapp
    ON clientes (whatsapp);

CREATE TRIGGER trg_clientes_updated_at
BEFORE UPDATE ON clientes
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- 3. RESPONSÁVEIS ADICIONAIS
-- ============================================================
CREATE TABLE responsaveis_adicionais (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    cliente_id          BIGINT NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
    nome                VARCHAR(180) NOT NULL,
    cpf                 VARCHAR(14),
    telefone            VARCHAR(30),
    email               VARCHAR(255),
    relacao             VARCHAR(80),
    observacoes         TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ix_responsaveis_cliente
    ON responsaveis_adicionais (cliente_id);

-- ============================================================
-- 4. ANIVERSARIANTES
-- ============================================================
CREATE TABLE aniversariantes (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    cliente_id          BIGINT NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
    nome                VARCHAR(150) NOT NULL,
    data_nascimento     DATE,
    observacoes         TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ix_aniversariantes_cliente
    ON aniversariantes (cliente_id);

CREATE TRIGGER trg_aniversariantes_updated_at
BEFORE UPDATE ON aniversariantes
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- 5. PACOTES
-- ============================================================
CREATE TABLE pacotes (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    nome                VARCHAR(120) NOT NULL,
    descricao           TEXT,
    duracao_minutos     INTEGER NOT NULL DEFAULT 240
                        CHECK (duracao_minutos > 0),
    ativo               BOOLEAN NOT NULL DEFAULT TRUE,
    ordem_exibicao      INTEGER NOT NULL DEFAULT 0,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX ux_pacotes_nome
    ON pacotes (LOWER(nome));

CREATE TRIGGER trg_pacotes_updated_at
BEFORE UPDATE ON pacotes
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- 6. TABELAS DE PREÇO
-- ============================================================
CREATE TABLE tabelas_preco (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    nome                VARCHAR(120) NOT NULL,
    vigencia_inicio     DATE NOT NULL,
    vigencia_fim        DATE,
    ativa               BOOLEAN NOT NULL DEFAULT TRUE,
    observacoes         TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CHECK (vigencia_fim IS NULL OR vigencia_fim >= vigencia_inicio)
);

CREATE INDEX ix_tabelas_preco_vigencia
    ON tabelas_preco (vigencia_inicio, vigencia_fim);

-- ============================================================
-- 7. PREÇOS POR PACOTE / FAIXA
-- ============================================================
CREATE TABLE precos_pacote (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tabela_preco_id     BIGINT NOT NULL REFERENCES tabelas_preco(id) ON DELETE RESTRICT,
    pacote_id           BIGINT NOT NULL REFERENCES pacotes(id) ON DELETE RESTRICT,
    convidados_min      INTEGER NOT NULL CHECK (convidados_min > 0),
    convidados_max      INTEGER NOT NULL CHECK (convidados_max >= convidados_min),
    valor               NUMERIC(12,2) NOT NULL CHECK (valor >= 0),
    categoria_horario   VARCHAR(80),
    observacoes         TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ix_precos_pacote_busca
    ON precos_pacote (tabela_preco_id, pacote_id, convidados_min, convidados_max);

-- ============================================================
-- 8. ADICIONAIS
-- ============================================================
CREATE TABLE adicionais (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    nome                VARCHAR(150) NOT NULL,
    descricao           TEXT,
    unidade_cobranca    VARCHAR(30) NOT NULL DEFAULT 'valor_fixo',
    valor_padrao        NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (valor_padrao >= 0),
    ativo               BOOLEAN NOT NULL DEFAULT TRUE,
    observacoes         TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX ux_adicionais_nome
    ON adicionais (LOWER(nome));

CREATE TRIGGER trg_adicionais_updated_at
BEFORE UPDATE ON adicionais
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- 9. CONFIGURAÇÃO DE AGENDA
-- ============================================================
CREATE TABLE configuracao_agenda (
    id                          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    nome                        VARCHAR(80) NOT NULL,
    horario_inicio_padrao       TIME NOT NULL,
    horario_fim_padrao          TIME NOT NULL,
    tolerancia_inicio_minutos   INTEGER NOT NULL DEFAULT 30
                                CHECK (tolerancia_inicio_minutos >= 0),
    ativo                       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CHECK (horario_fim_padrao > horario_inicio_padrao)
);

-- ============================================================
-- 10. BLOQUEIOS DE AGENDA
-- ============================================================
CREATE TABLE bloqueios_agenda (
    id                      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    data                    DATE NOT NULL,
    horario_inicio          TIME NOT NULL,
    horario_fim             TIME NOT NULL,
    motivo                  TEXT,
    criado_por_usuario_id   BIGINT REFERENCES usuarios(id) ON DELETE SET NULL,
    ativo                   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CHECK (horario_fim > horario_inicio)
);

CREATE INDEX ix_bloqueios_agenda_data
    ON bloqueios_agenda (data, horario_inicio, horario_fim)
    WHERE ativo = TRUE;

-- ============================================================
-- 11. FECHAMENTOS
-- ============================================================
CREATE TABLE fechamentos (
    id                          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    cliente_id                  BIGINT REFERENCES clientes(id) ON DELETE SET NULL,
    aniversariante_id           BIGINT REFERENCES aniversariantes(id) ON DELETE SET NULL,
    pacote_id                   BIGINT REFERENCES pacotes(id) ON DELETE RESTRICT,
    tabela_preco_id             BIGINT REFERENCES tabelas_preco(id) ON DELETE RESTRICT,

    data_evento                 DATE NOT NULL,
    horario_inicio              TIME NOT NULL,
    horario_fim                 TIME NOT NULL,
    convidados                  INTEGER NOT NULL CHECK (convidados > 0),

    valor_tabela                NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (valor_tabela >= 0),
    valor_negociado             NUMERIC(12,2) CHECK (valor_negociado IS NULL OR valor_negociado >= 0),
    valor_aprovado              NUMERIC(12,2) CHECK (valor_aprovado IS NULL OR valor_aprovado >= 0),

    motivo_negociacao           VARCHAR(80),
    observacoes_negociacao      TEXT,

    status                      VARCHAR(40) NOT NULL DEFAULT 'RASCUNHO'
                                CHECK (status IN (
                                    'RASCUNHO',
                                    'AGUARDANDO_APROVACAO',
                                    'APROVADO',
                                    'AGUARDANDO_CONTRATO',
                                    'CONTRATO_ASSINADO',
                                    'AGUARDANDO_PAGAMENTO',
                                    'CONFIRMADO',
                                    'CANCELADO',
                                    'RECUSADO',
                                    'EXPIRADO'
                                )),

    iniciado_por_tipo           VARCHAR(20) NOT NULL
                                CHECK (iniciado_por_tipo IN ('cliente', 'atendente')),

    usuario_responsavel_id      BIGINT REFERENCES usuarios(id) ON DELETE SET NULL,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CHECK (horario_fim > horario_inicio)
);

CREATE INDEX ix_fechamentos_data
    ON fechamentos (data_evento, horario_inicio, horario_fim);

CREATE INDEX ix_fechamentos_status
    ON fechamentos (status);

CREATE INDEX ix_fechamentos_cliente
    ON fechamentos (cliente_id);

CREATE TRIGGER trg_fechamentos_updated_at
BEFORE UPDATE ON fechamentos
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- 12. ADICIONAIS DO FECHAMENTO
-- ============================================================
CREATE TABLE fechamento_adicionais (
    id                          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    fechamento_id               BIGINT NOT NULL REFERENCES fechamentos(id) ON DELETE CASCADE,
    adicional_id                BIGINT NOT NULL REFERENCES adicionais(id) ON DELETE RESTRICT,
    quantidade                  NUMERIC(10,2) NOT NULL DEFAULT 1 CHECK (quantidade > 0),
    valor_unitario_aplicado     NUMERIC(12,2) NOT NULL CHECK (valor_unitario_aplicado >= 0),
    valor_total                 NUMERIC(12,2) NOT NULL CHECK (valor_total >= 0),
    observacoes                 TEXT,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ix_fechamento_adicionais_fechamento
    ON fechamento_adicionais (fechamento_id);

-- ============================================================
-- 13. ALTERAÇÕES DO PACOTE
-- ============================================================
CREATE TABLE alteracoes_pacote (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    fechamento_id       BIGINT NOT NULL REFERENCES fechamentos(id) ON DELETE CASCADE,
    tipo                VARCHAR(20) NOT NULL
                        CHECK (tipo IN ('adicionar', 'retirar', 'substituir', 'observacao')),
    descricao           TEXT NOT NULL,
    impacto_valor       NUMERIC(12,2),
    observacoes         TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ix_alteracoes_pacote_fechamento
    ON alteracoes_pacote (fechamento_id);

-- ============================================================
-- 14. APROVAÇÕES DE NEGOCIAÇÃO
-- ============================================================
CREATE TABLE aprovacoes_negociacao (
    id                          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    fechamento_id               BIGINT NOT NULL REFERENCES fechamentos(id) ON DELETE CASCADE,
    valor_informado             NUMERIC(12,2) NOT NULL CHECK (valor_informado >= 0),
    valor_aprovado              NUMERIC(12,2) CHECK (valor_aprovado IS NULL OR valor_aprovado >= 0),
    status                      VARCHAR(20) NOT NULL DEFAULT 'pendente'
                                CHECK (status IN ('pendente', 'aprovado', 'corrigido', 'recusado')),
    motivo                      VARCHAR(100),
    aprovado_por_usuario_id     BIGINT REFERENCES usuarios(id) ON DELETE SET NULL,
    observacoes                 TEXT,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ix_aprovacoes_fechamento
    ON aprovacoes_negociacao (fechamento_id, created_at);

-- ============================================================
-- 15. CONTRATOS
-- ============================================================
CREATE TABLE contratos (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    fechamento_id       BIGINT NOT NULL REFERENCES fechamentos(id) ON DELETE CASCADE,
    numero              VARCHAR(80),
    versao              INTEGER NOT NULL DEFAULT 1 CHECK (versao > 0),
    status              VARCHAR(30) NOT NULL DEFAULT 'rascunho'
                        CHECK (status IN (
                            'rascunho',
                            'enviado',
                            'aguardando_assinatura',
                            'assinado',
                            'cancelado'
                        )),
    arquivo_pdf         TEXT,
    enviado_em          TIMESTAMPTZ,
    assinado_em         TIMESTAMPTZ,
    observacoes         TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (fechamento_id, versao)
);

CREATE INDEX ix_contratos_fechamento
    ON contratos (fechamento_id);

-- ============================================================
-- 16. FESTAS
-- ============================================================
CREATE TABLE festas (
    id                      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    fechamento_id           BIGINT NOT NULL UNIQUE REFERENCES fechamentos(id) ON DELETE RESTRICT,
    cliente_id              BIGINT NOT NULL REFERENCES clientes(id) ON DELETE RESTRICT,
    aniversariante_id       BIGINT REFERENCES aniversariantes(id) ON DELETE SET NULL,
    pacote_id               BIGINT NOT NULL REFERENCES pacotes(id) ON DELETE RESTRICT,

    data                    DATE NOT NULL,
    horario_inicio          TIME NOT NULL,
    horario_fim             TIME NOT NULL,
    convidados_contratados  INTEGER NOT NULL CHECK (convidados_contratados > 0),
    tema                    VARCHAR(180),

    status                  VARCHAR(30) NOT NULL DEFAULT 'confirmada'
                            CHECK (status IN (
                                'confirmada',
                                'em_preparacao',
                                'realizada',
                                'cancelada'
                            )),

    observacoes             TEXT,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CHECK (horario_fim > horario_inicio)
);

CREATE INDEX ix_festas_agenda
    ON festas (data, horario_inicio, horario_fim)
    WHERE status <> 'cancelada';

CREATE INDEX ix_festas_cliente
    ON festas (cliente_id);

CREATE TRIGGER trg_festas_updated_at
BEFORE UPDATE ON festas
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- 17. PAGAMENTOS
-- ============================================================
CREATE TABLE pagamentos (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    fechamento_id       BIGINT NOT NULL REFERENCES fechamentos(id) ON DELETE RESTRICT,

    forma               VARCHAR(30) NOT NULL
                        CHECK (forma IN ('pix', 'cartao', 'pix_parcelado', 'outro')),

    valor_bruto         NUMERIC(12,2) NOT NULL CHECK (valor_bruto >= 0),
    desconto            NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (desconto >= 0),
    valor_pago          NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (valor_pago >= 0),

    taxa_percentual     NUMERIC(7,4) NOT NULL DEFAULT 0 CHECK (taxa_percentual >= 0),
    taxa_valor          NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (taxa_valor >= 0),
    valor_liquido       NUMERIC(12,2) CHECK (valor_liquido IS NULL OR valor_liquido >= 0),

    parcelas_cartao     INTEGER CHECK (
                            parcelas_cartao IS NULL
                            OR parcelas_cartao BETWEEN 1 AND 6
                        ),

    operadora           VARCHAR(80),
    status              VARCHAR(20) NOT NULL DEFAULT 'pendente'
                        CHECK (status IN ('pendente', 'pago', 'cancelado', 'estornado')),

    data_pagamento      TIMESTAMPTZ,
    referencia_externa  VARCHAR(255),
    observacoes         TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ix_pagamentos_fechamento
    ON pagamentos (fechamento_id);

CREATE INDEX ix_pagamentos_status
    ON pagamentos (status);

-- ============================================================
-- 18. PARCELAS PIX DIRETO
-- ============================================================
CREATE TABLE parcelas (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    pagamento_id        BIGINT NOT NULL REFERENCES pagamentos(id) ON DELETE CASCADE,
    numero_parcela      INTEGER NOT NULL CHECK (numero_parcela > 0),
    valor               NUMERIC(12,2) NOT NULL CHECK (valor > 0),
    vencimento          DATE NOT NULL,
    data_pagamento      TIMESTAMPTZ,
    status              VARCHAR(20) NOT NULL DEFAULT 'pendente'
                        CHECK (status IN ('pendente', 'pago', 'vencido', 'cancelado')),
    comprovante         TEXT,
    observacoes         TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (pagamento_id, numero_parcela)
);

CREATE INDEX ix_parcelas_vencimento
    ON parcelas (vencimento, status);

-- ============================================================
-- 19. TAXAS DE CARTÃO
-- ============================================================
CREATE TABLE taxas_cartao (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    operadora           VARCHAR(80) NOT NULL,
    modalidade          VARCHAR(50) NOT NULL,
    parcelas            INTEGER NOT NULL CHECK (parcelas BETWEEN 1 AND 12),
    taxa_percentual     NUMERIC(7,4) NOT NULL DEFAULT 0 CHECK (taxa_percentual >= 0),
    taxa_fixa           NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (taxa_fixa >= 0),
    vigencia_inicio     DATE NOT NULL,
    vigencia_fim        DATE,
    ativa               BOOLEAN NOT NULL DEFAULT TRUE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CHECK (vigencia_fim IS NULL OR vigencia_fim >= vigencia_inicio)
);

CREATE INDEX ix_taxas_cartao_busca
    ON taxas_cartao (operadora, parcelas, vigencia_inicio, vigencia_fim);

-- ============================================================
-- DADOS INICIAIS DE AGENDA
-- ============================================================
INSERT INTO configuracao_agenda
    (nome, horario_inicio_padrao, horario_fim_padrao, tolerancia_inicio_minutos)
VALUES
    ('Festa 1', '11:00', '15:00', 30),
    ('Festa 2', '17:00', '21:00', 30);

COMMIT;

-- ============================================================
-- FIM DO SCHEMA MVP
-- ============================================================
