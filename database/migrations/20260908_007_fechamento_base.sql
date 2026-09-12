-- =============================================================================
-- Kidmais Manager
-- Migration 007 — Núcleo persistente de Fechamento
-- Arquivo: 20260908_007_fechamento_base.sql
--
-- Escopo desta migration:
--   1. fechamentos
--   2. fechamento_adicionais
--   3. aprovacoes_negociacao
--
-- Decisões preservadas:
--   - Fechamento NÃO reserva horário.
--   - NÃO existe UNIQUE por data/horário em fechamentos.
--   - A disponibilidade exata recebida do módulo Disponibilidade é preservada:
--       data_evento + horario_inicio + horario_fim + configuracao_agenda_id.
--   - O valor oficial calculado pelo backend é preservado historicamente.
--   - Negociação não sobrescreve valor de tabela.
--   - Adicionais congelam nome/unidade/valores aplicados.
--   - aprovacoes_negociacao é histórico: cada decisão/correção deve gerar registro.
--   - Usuários ainda não possuem FK física nesta etapa; IDs ficam transitórios.
--   - OTP / identidade NÃO pertence a esta migration (fica para 008).
--   - Festa / Contrato / Pagamentos NÃO são criados nesta migration.
--   - schema_mvp_kidmais.sql permanece legado/provisório e NÃO é alterado.
-- =============================================================================

BEGIN;

-- =============================================================================
-- 0. PRÉ-REQUISITOS
-- =============================================================================

DO $$
BEGIN
    IF to_regclass('public.clientes') IS NULL THEN
        RAISE EXCEPTION 'Migration 007 exige a tabela clientes.';
    END IF;

    IF to_regclass('public.aniversariantes') IS NULL THEN
        RAISE EXCEPTION 'Migration 007 exige a tabela aniversariantes.';
    END IF;

    IF to_regclass('public.configuracao_agenda') IS NULL THEN
        RAISE EXCEPTION 'Migration 007 exige a tabela configuracao_agenda.';
    END IF;

    IF to_regclass('public.pacotes') IS NULL THEN
        RAISE EXCEPTION 'Migration 007 exige a tabela pacotes.';
    END IF;

    IF to_regclass('public.tabelas_preco') IS NULL THEN
        RAISE EXCEPTION 'Migration 007 exige a tabela tabelas_preco.';
    END IF;

    IF to_regclass('public.precos_pacote') IS NULL THEN
        RAISE EXCEPTION 'Migration 007 exige a tabela precos_pacote.';
    END IF;

    IF to_regclass('public.adicionais') IS NULL THEN
        RAISE EXCEPTION 'Migration 007 exige a tabela adicionais.';
    END IF;

    IF to_regclass('public.precos_adicional') IS NULL THEN
        RAISE EXCEPTION 'Migration 007 exige a tabela precos_adicional.';
    END IF;

    IF to_regclass('public.regras_desconto_pacote') IS NULL THEN
        RAISE EXCEPTION 'Migration 007 exige a tabela regras_desconto_pacote.';
    END IF;

    IF to_regprocedure('public.kidmais_set_atualizado_em()') IS NULL THEN
        RAISE EXCEPTION 'Migration 007 exige a função kidmais_set_atualizado_em().';
    END IF;
END;
$$;

-- =============================================================================
-- 1. FECHAMENTOS
-- =============================================================================

CREATE TABLE fechamentos (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Identidade / CRM.
    -- Permanecem nullable para permitir RASCUNHO e a futura integração da migration 008.
    cliente_id uuid,
    aniversariante_id uuid,

    -- Seleção exata recebida da Disponibilidade.
    data_evento date NOT NULL,
    horario_inicio time without time zone NOT NULL,
    horario_fim time without time zone NOT NULL,
    configuracao_agenda_id uuid NOT NULL,

    -- Contexto comercial aplicado.
    pacote_id uuid NOT NULL,
    tabela_preco_id uuid NOT NULL,
    preco_pacote_id uuid NOT NULL,
    regra_desconto_pacote_id uuid,

    -- PADRAO/NOBRE representa a categoria do dia/turno.
    -- categoria_preco_aplicada pode ser GERAL para Pocket/Mini/Compacta.
    categoria_horario varchar(20) NOT NULL,
    categoria_preco_aplicada varchar(20) NOT NULL,

    convidados smallint NOT NULL,
    convidados_faturados smallint NOT NULL,

    -- Snapshot do cálculo oficial do PricingService.
    valor_pacote_base numeric(12,2) NOT NULL,
    desconto_percentual numeric(5,2) NOT NULL DEFAULT 0,
    valor_desconto_pacote numeric(12,2) NOT NULL DEFAULT 0,
    valor_pacote_aplicado numeric(12,2) NOT NULL,
    valor_adicionais numeric(12,2) NOT NULL DEFAULT 0,
    valor_tabela numeric(12,2) NOT NULL,

    -- Negociação nunca substitui o valor_tabela.
    valor_negociado numeric(12,2),
    valor_aprovado numeric(12,2),
    motivo_negociacao text,
    observacoes_negociacao text,

    status varchar(30) NOT NULL DEFAULT 'RASCUNHO',
    origem_fechamento varchar(30) NOT NULL,

    -- IDs transitórios até o módulo de autenticação/usuários estar consolidado.
    iniciado_por_usuario_id uuid,
    iniciado_em timestamptz NOT NULL DEFAULT now(),
    usuario_responsavel_id uuid,

    observacoes_equipe text,
    buffet_status varchar(20) NOT NULL DEFAULT 'PENDENTE',

    criado_em timestamptz NOT NULL DEFAULT now(),
    atualizado_em timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT fechamentos_cliente_fk
        FOREIGN KEY (cliente_id)
        REFERENCES clientes(id)
        ON DELETE RESTRICT,

    CONSTRAINT fechamentos_aniversariante_fk
        FOREIGN KEY (aniversariante_id)
        REFERENCES aniversariantes(id)
        ON DELETE RESTRICT,

    CONSTRAINT fechamentos_configuracao_agenda_fk
        FOREIGN KEY (configuracao_agenda_id)
        REFERENCES configuracao_agenda(id)
        ON DELETE RESTRICT,

    CONSTRAINT fechamentos_pacote_fk
        FOREIGN KEY (pacote_id)
        REFERENCES pacotes(id)
        ON DELETE RESTRICT,

    CONSTRAINT fechamentos_tabela_preco_fk
        FOREIGN KEY (tabela_preco_id)
        REFERENCES tabelas_preco(id)
        ON DELETE RESTRICT,

    CONSTRAINT fechamentos_preco_pacote_fk
        FOREIGN KEY (preco_pacote_id)
        REFERENCES precos_pacote(id)
        ON DELETE RESTRICT,

    CONSTRAINT fechamentos_regra_desconto_fk
        FOREIGN KEY (regra_desconto_pacote_id)
        REFERENCES regras_desconto_pacote(id)
        ON DELETE RESTRICT,

    CONSTRAINT fechamentos_horario_check CHECK (
        horario_fim > horario_inicio
    ),

    CONSTRAINT fechamentos_categoria_horario_check CHECK (
        categoria_horario IN ('PADRAO', 'NOBRE')
    ),

    CONSTRAINT fechamentos_categoria_preco_check CHECK (
        categoria_preco_aplicada IN ('GERAL', 'PADRAO', 'NOBRE')
    ),

    CONSTRAINT fechamentos_convidados_check CHECK (
        convidados > 0
    ),

    CONSTRAINT fechamentos_convidados_faturados_check CHECK (
        convidados_faturados >= convidados
    ),

    CONSTRAINT fechamentos_valor_pacote_base_check CHECK (
        valor_pacote_base > 0
    ),

    CONSTRAINT fechamentos_desconto_percentual_check CHECK (
        desconto_percentual >= 0 AND desconto_percentual <= 100
    ),

    CONSTRAINT fechamentos_valor_desconto_check CHECK (
        valor_desconto_pacote >= 0
        AND valor_desconto_pacote <= valor_pacote_base
    ),

    CONSTRAINT fechamentos_valor_pacote_aplicado_check CHECK (
        valor_pacote_aplicado > 0
    ),

    CONSTRAINT fechamentos_valor_adicionais_check CHECK (
        valor_adicionais >= 0
    ),

    CONSTRAINT fechamentos_valor_tabela_check CHECK (
        valor_tabela > 0
    ),

    CONSTRAINT fechamentos_valor_negociado_check CHECK (
        valor_negociado IS NULL OR valor_negociado > 0
    ),

    CONSTRAINT fechamentos_valor_aprovado_check CHECK (
        valor_aprovado IS NULL OR valor_aprovado > 0
    ),

    CONSTRAINT fechamentos_aprovado_exige_negociacao_check CHECK (
        valor_aprovado IS NULL OR valor_negociado IS NOT NULL
    ),

    CONSTRAINT fechamentos_status_check CHECK (
        status IN (
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
        )
    ),

    CONSTRAINT fechamentos_status_negociacao_check CHECK (
        status <> 'AGUARDANDO_APROVACAO'
        OR valor_negociado IS NOT NULL
    ),

    CONSTRAINT fechamentos_status_aprovado_check CHECK (
        status <> 'APROVADO'
        OR valor_aprovado IS NOT NULL
    ),

    CONSTRAINT fechamentos_origem_check CHECK (
        origem_fechamento IN ('CLIENTE', 'ATENDIMENTO_KIDMAIS')
    ),

    CONSTRAINT fechamentos_buffet_status_check CHECK (
        buffet_status IN ('PENDENTE', 'DEFINIDO')
    )
);

-- IMPORTANTE:
-- Este índice é apenas para consulta/revalidação.
-- Ele NÃO é UNIQUE e NÃO cria reserva de horário.
CREATE INDEX fechamentos_agenda_idx
    ON fechamentos (
        data_evento,
        horario_inicio,
        horario_fim,
        status
    );

CREATE INDEX fechamentos_status_idx
    ON fechamentos (status, criado_em DESC);

CREATE INDEX fechamentos_cliente_idx
    ON fechamentos (cliente_id, criado_em DESC)
    WHERE cliente_id IS NOT NULL;

CREATE INDEX fechamentos_aniversariante_idx
    ON fechamentos (aniversariante_id, criado_em DESC)
    WHERE aniversariante_id IS NOT NULL;

CREATE INDEX fechamentos_pacote_idx
    ON fechamentos (pacote_id, data_evento);

CREATE TRIGGER fechamentos_atualizado_em_trg
BEFORE UPDATE ON fechamentos
FOR EACH ROW
EXECUTE FUNCTION kidmais_set_atualizado_em();

COMMENT ON TABLE fechamentos IS
'Contratação comercial em andamento. Não representa reserva de agenda nem Festa confirmada.';

COMMENT ON COLUMN fechamentos.valor_tabela IS
'Valor oficial aplicável no momento do fechamento, preservado separadamente de negociação.';

COMMENT ON COLUMN fechamentos.valor_negociado IS
'Valor proposto em negociação quando diferente do valor oficial de tabela.';

COMMENT ON COLUMN fechamentos.configuracao_agenda_id IS
'Configuração/turno exato recebido da Disponibilidade; não reconstruir a partir do horário.';

-- =============================================================================
-- 2. FECHAMENTO_ADICIONAIS
-- =============================================================================

CREATE TABLE fechamento_adicionais (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    fechamento_id uuid NOT NULL,
    adicional_id uuid NOT NULL,
    preco_adicional_id uuid NOT NULL,

    -- Snapshot histórico.
    nome_aplicado text NOT NULL,
    unidade_cobranca_aplicada varchar(20) NOT NULL,
    quantidade numeric(12,3) NOT NULL DEFAULT 1,
    valor_unitario_aplicado numeric(12,2) NOT NULL,
    valor_total numeric(12,2) NOT NULL,

    observacoes text,
    criado_em timestamptz NOT NULL DEFAULT now(),
    atualizado_em timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT fechamento_adicionais_fechamento_fk
        FOREIGN KEY (fechamento_id)
        REFERENCES fechamentos(id)
        ON DELETE RESTRICT,

    CONSTRAINT fechamento_adicionais_adicional_fk
        FOREIGN KEY (adicional_id)
        REFERENCES adicionais(id)
        ON DELETE RESTRICT,

    CONSTRAINT fechamento_adicionais_preco_fk
        FOREIGN KEY (preco_adicional_id)
        REFERENCES precos_adicional(id)
        ON DELETE RESTRICT,

    CONSTRAINT fechamento_adicionais_nome_check CHECK (
        btrim(nome_aplicado) <> ''
    ),

    CONSTRAINT fechamento_adicionais_unidade_check CHECK (
        unidade_cobranca_aplicada IN (
            'VALOR_FIXO',
            'CONVIDADO',
            'UNIDADE',
            'CENTO',
            'HORA',
            'PACOTE',
            'METRO'
        )
    ),

    CONSTRAINT fechamento_adicionais_quantidade_check CHECK (
        quantidade > 0
    ),

    CONSTRAINT fechamento_adicionais_valor_unitario_check CHECK (
        valor_unitario_aplicado >= 0
    ),

    CONSTRAINT fechamento_adicionais_valor_total_check CHECK (
        valor_total >= 0
    ),

    CONSTRAINT fechamento_adicionais_item_uk UNIQUE (
        fechamento_id,
        adicional_id
    )
);

CREATE INDEX fechamento_adicionais_fechamento_idx
    ON fechamento_adicionais (fechamento_id);

CREATE TRIGGER fechamento_adicionais_atualizado_em_trg
BEFORE UPDATE ON fechamento_adicionais
FOR EACH ROW
EXECUTE FUNCTION kidmais_set_atualizado_em();

COMMENT ON TABLE fechamento_adicionais IS
'Snapshot dos adicionais selecionados; valores não dependem de mudanças comerciais futuras.';

-- =============================================================================
-- 3. APROVACOES_NEGOCIACAO
-- =============================================================================

CREATE TABLE aprovacoes_negociacao (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    fechamento_id uuid NOT NULL,

    valor_informado numeric(12,2) NOT NULL,
    valor_aprovado numeric(12,2),

    status varchar(20) NOT NULL,
    motivo text,

    -- FK de usuário será adicionada quando autenticação/usuários estiver consolidada.
    aprovado_por_usuario_id uuid,

    observacoes text,
    criado_em timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT aprovacoes_negociacao_fechamento_fk
        FOREIGN KEY (fechamento_id)
        REFERENCES fechamentos(id)
        ON DELETE RESTRICT,

    CONSTRAINT aprovacoes_negociacao_valor_informado_check CHECK (
        valor_informado > 0
    ),

    CONSTRAINT aprovacoes_negociacao_valor_aprovado_check CHECK (
        valor_aprovado IS NULL OR valor_aprovado > 0
    ),

    CONSTRAINT aprovacoes_negociacao_status_check CHECK (
        status IN (
            'PENDENTE',
            'APROVADO',
            'CORRIGIDO',
            'RECUSADO'
        )
    ),

    CONSTRAINT aprovacoes_negociacao_decisao_valor_check CHECK (
        status NOT IN ('APROVADO', 'CORRIGIDO')
        OR valor_aprovado IS NOT NULL
    )
);

CREATE INDEX aprovacoes_negociacao_fechamento_idx
    ON aprovacoes_negociacao (fechamento_id, criado_em DESC);

CREATE INDEX aprovacoes_negociacao_status_idx
    ON aprovacoes_negociacao (status, criado_em DESC);

COMMENT ON TABLE aprovacoes_negociacao IS
'Histórico append-only por regra de aplicação: novas aprovações/correções geram novos registros, sem sobrescrever decisões anteriores.';

-- =============================================================================
-- 4. VALIDAÇÃO ESTRUTURAL
-- =============================================================================

DO $$
DECLARE
    v_tabelas integer;
BEGIN
    SELECT count(*)
      INTO v_tabelas
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind = 'r'
       AND c.relname IN (
           'fechamentos',
           'fechamento_adicionais',
           'aprovacoes_negociacao'
       );

    IF v_tabelas <> 3 THEN
        RAISE EXCEPTION
            'Migration 007 incompleta: esperadas 3 tabelas, encontradas %.',
            v_tabelas;
    END IF;
END;
$$;

COMMIT;
