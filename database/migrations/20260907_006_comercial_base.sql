BEGIN;

-- Kidmais Manager — Comercial Base
-- Migration 006 (DRAFT v2)
--
-- Escopo:
--   1) pacotes
--   2) tabelas_preco
--   3) regras_categoria_horario
--   4) precos_pacote
--   5) adicionais
--   6) precos_adicional
--   7) regras_disponibilidade_pacote
--   8) regras_desconto_pacote
--
-- IMPORTANTE:
-- - DRAFT para validação. NÃO aplicar ainda.
-- - schema_mvp_kidmais.sql permanece legado/provisório e não é alterado.
-- - Requer a migration 001 (pgcrypto + kidmais_set_atualizado_em)
--   e a migration 005 (configuracao_agenda com TURNO_1/TURNO_2).
-- - Regra de preço por horário consolidada nesta revisão:
--     NOBRE  = sábado TURNO_2 e domingo TURNO_1.
--     PADRAO = demais combinações regulares.
--   Desconto de dia útil é regra separada e incide sobre o preço PADRAO.
-- - Feriados e vésperas NÃO recebem comportamento automático nesta migration.

DO $$
BEGIN
    IF (
        SELECT count(*)
          FROM configuracao_agenda
         WHERE codigo IN ('TURNO_1', 'TURNO_2')
           AND ativo = true
    ) <> 2 THEN
        RAISE EXCEPTION
            'Migration 006 requer configuracao_agenda ativa com TURNO_1 e TURNO_2 (migration 005).';
    END IF;
END;
$$;

-- =============================================================================
-- 1. PACOTES
-- =============================================================================

CREATE TABLE pacotes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    codigo varchar(50) NOT NULL,
    nome text NOT NULL,
    descricao text,
    convidados_minimos smallint,
    convidados_maximos smallint,
    duracao_minutos smallint,
    ordem_exibicao smallint NOT NULL,
    ativo boolean NOT NULL DEFAULT true,
    criado_em timestamptz NOT NULL DEFAULT now(),
    atualizado_em timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT pacotes_codigo_uk UNIQUE (codigo),
    CONSTRAINT pacotes_codigo_nao_vazio CHECK (btrim(codigo) <> ''),
    CONSTRAINT pacotes_nome_nao_vazio CHECK (btrim(nome) <> ''),
    CONSTRAINT pacotes_convidados_minimos_check CHECK (
        convidados_minimos IS NULL OR convidados_minimos > 0
    ),
    CONSTRAINT pacotes_convidados_maximos_check CHECK (
        convidados_maximos IS NULL OR convidados_maximos > 0
    ),
    CONSTRAINT pacotes_convidados_intervalo_check CHECK (
        convidados_minimos IS NULL
        OR convidados_maximos IS NULL
        OR convidados_maximos >= convidados_minimos
    ),
    CONSTRAINT pacotes_duracao_check CHECK (
        duracao_minutos IS NULL OR duracao_minutos > 0
    ),
    CONSTRAINT pacotes_ordem_check CHECK (ordem_exibicao > 0)
);

CREATE INDEX pacotes_ativos_idx
    ON pacotes (ordem_exibicao, nome)
    WHERE ativo = true;

CREATE TRIGGER pacotes_atualizado_em_trg
BEFORE UPDATE ON pacotes
FOR EACH ROW
EXECUTE FUNCTION kidmais_set_atualizado_em();

-- Identidade dos pacotes e mínimos já usados no fluxo atual.
-- convidados_maximos permanece NULL quando não há limite comercial específico
-- persistido; a faixa disponível será determinada pela tabela de preços.
INSERT INTO pacotes (
    codigo,
    nome,
    convidados_minimos,
    ordem_exibicao
)
VALUES
    ('POCKET',      'Kidmais Pocket',      20, 1),
    ('MINI_FESTA',  'Mini Festa Kidmais',  30, 2),
    ('COMPACTA',    'Festa Compacta',      40, 3),
    ('ESSENCIAL',   'Festa Essencial',     50, 4),
    ('COMPLETA',    'Festa Completa',      50, 5),
    ('PREMIUM',     'Festa Premium',       50, 6),
    ('PIZZA_PARTY', 'Pizza Party',        NULL, 7);

-- =============================================================================
-- 2. TABELAS DE PREÇO VERSIONADAS
-- =============================================================================

CREATE TABLE tabelas_preco (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    codigo varchar(50) NOT NULL,
    nome text NOT NULL,
    vigencia_inicio date NOT NULL,
    vigencia_fim date,
    ativa boolean NOT NULL DEFAULT false,
    observacoes text,
    criado_em timestamptz NOT NULL DEFAULT now(),
    atualizado_em timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT tabelas_preco_codigo_uk UNIQUE (codigo),
    CONSTRAINT tabelas_preco_codigo_nao_vazio CHECK (btrim(codigo) <> ''),
    CONSTRAINT tabelas_preco_nome_nao_vazio CHECK (btrim(nome) <> ''),
    CONSTRAINT tabelas_preco_vigencia_check CHECK (
        vigencia_fim IS NULL OR vigencia_fim >= vigencia_inicio
    )
);

CREATE INDEX tabelas_preco_vigencia_ativas_idx
    ON tabelas_preco (vigencia_inicio, vigencia_fim)
    WHERE ativa = true;

CREATE TRIGGER tabelas_preco_atualizado_em_trg
BEFORE UPDATE ON tabelas_preco
FOR EACH ROW
EXECUTE FUNCTION kidmais_set_atualizado_em();

INSERT INTO tabelas_preco (
    codigo,
    nome,
    vigencia_inicio,
    ativa,
    observacoes
)
VALUES (
    'COMERCIAL_2026_09',
    'Tabela comercial vigente — setembro/2026',
    DATE '2026-09-07',
    true,
    'Primeira versão persistida pelo núcleo comercial. Não retroage fechamentos anteriores.'
);

-- =============================================================================
-- 3. REGRA DE CATEGORIA DE PREÇO POR DIA/TURNO
-- =============================================================================
-- Conceito separado da disponibilidade comercial do pacote.
-- ISO-8601: 1=segunda ... 7=domingo.
-- Categoria atual:
--   NOBRE  = sábado TURNO_2 OU domingo TURNO_1
--   PADRAO = demais combinações regulares.
--
-- Feriados e vésperas ficam fora desta regra até definição oficial.

CREATE TABLE regras_categoria_horario (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    dia_semana smallint NOT NULL,
    configuracao_agenda_id uuid NOT NULL,
    categoria_horario varchar(20) NOT NULL,
    vigencia_inicio date NOT NULL,
    vigencia_fim date,
    ativo boolean NOT NULL DEFAULT true,
    observacoes text,
    criado_em timestamptz NOT NULL DEFAULT now(),
    atualizado_em timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT regras_categoria_horario_config_fk
        FOREIGN KEY (configuracao_agenda_id)
        REFERENCES configuracao_agenda(id)
        ON DELETE RESTRICT,
    CONSTRAINT regras_categoria_horario_dia_check
        CHECK (dia_semana BETWEEN 1 AND 7),
    CONSTRAINT regras_categoria_horario_categoria_check
        CHECK (categoria_horario IN ('PADRAO', 'NOBRE')),
    CONSTRAINT regras_categoria_horario_vigencia_check
        CHECK (vigencia_fim IS NULL OR vigencia_fim >= vigencia_inicio),
    CONSTRAINT regras_categoria_horario_inicio_uk UNIQUE (
        dia_semana,
        configuracao_agenda_id,
        vigencia_inicio
    )
);

CREATE INDEX regras_categoria_horario_busca_idx
    ON regras_categoria_horario (
        dia_semana,
        configuracao_agenda_id,
        vigencia_inicio,
        vigencia_fim
    )
    WHERE ativo = true;

CREATE TRIGGER regras_categoria_horario_atualizado_em_trg
BEFORE UPDATE ON regras_categoria_horario
FOR EACH ROW
EXECUTE FUNCTION kidmais_set_atualizado_em();

CREATE OR REPLACE FUNCTION kidmais_validar_vigencia_categoria_horario()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.ativo = true AND EXISTS (
        SELECT 1
          FROM regras_categoria_horario r
         WHERE r.id <> NEW.id
           AND r.ativo = true
           AND r.dia_semana = NEW.dia_semana
           AND r.configuracao_agenda_id = NEW.configuracao_agenda_id
           AND daterange(r.vigencia_inicio, r.vigencia_fim, '[]')
               && daterange(NEW.vigencia_inicio, NEW.vigencia_fim, '[]')
    ) THEN
        RAISE EXCEPTION
            'Vigência de categoria de horário sobreposta para dia % e configuração %',
            NEW.dia_semana,
            NEW.configuracao_agenda_id;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER regras_categoria_horario_validar_vigencia_trg
BEFORE INSERT OR UPDATE OF
    dia_semana,
    configuracao_agenda_id,
    vigencia_inicio,
    vigencia_fim,
    ativo
ON regras_categoria_horario
FOR EACH ROW
EXECUTE FUNCTION kidmais_validar_vigencia_categoria_horario();

WITH dias AS (
    SELECT generate_series(1, 7)::smallint AS dia_semana
),
configs AS (
    SELECT id, codigo
      FROM configuracao_agenda
     WHERE codigo IN ('TURNO_1', 'TURNO_2')
       AND ativo = true
)
INSERT INTO regras_categoria_horario (
    dia_semana,
    configuracao_agenda_id,
    categoria_horario,
    vigencia_inicio,
    observacoes
)
SELECT
    d.dia_semana,
    c.id,
    CASE
        WHEN d.dia_semana = 6 AND c.codigo = 'TURNO_2' THEN 'NOBRE'
        WHEN d.dia_semana = 7 AND c.codigo = 'TURNO_1' THEN 'NOBRE'
        ELSE 'PADRAO'
    END,
    DATE '2026-09-07',
    'Regra regular de categoria de preço. Feriados/vésperas não automatizados.'
FROM dias d
CROSS JOIN configs c;

-- =============================================================================
-- 4. PREÇOS DE PACOTES
-- =============================================================================
-- tipo_calculo:
--   FIXO          -> valor total daquela faixa.
--   POR_CONVIDADO -> valor por convidado; convidados_min é também o mínimo
--                    faturável da regra.
--
-- categoria_horario representa a categoria de preço determinada pela regra
-- anterior. Descontos NÃO alteram o preço de tabela; são aplicados separadamente.

CREATE TABLE precos_pacote (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tabela_preco_id uuid NOT NULL,
    pacote_id uuid NOT NULL,
    convidados_min smallint NOT NULL,
    convidados_max smallint,
    tipo_calculo varchar(20) NOT NULL,
    valor numeric(12,2) NOT NULL,
    categoria_horario varchar(20) NOT NULL,
    observacoes text,
    ativo boolean NOT NULL DEFAULT true,
    criado_em timestamptz NOT NULL DEFAULT now(),
    atualizado_em timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT precos_pacote_tabela_fk
        FOREIGN KEY (tabela_preco_id)
        REFERENCES tabelas_preco(id)
        ON DELETE RESTRICT,
    CONSTRAINT precos_pacote_pacote_fk
        FOREIGN KEY (pacote_id)
        REFERENCES pacotes(id)
        ON DELETE RESTRICT,
    CONSTRAINT precos_pacote_convidados_min_check CHECK (convidados_min > 0),
    CONSTRAINT precos_pacote_convidados_intervalo_check CHECK (
        convidados_max IS NULL OR convidados_max >= convidados_min
    ),
    CONSTRAINT precos_pacote_tipo_calculo_check CHECK (
        tipo_calculo IN ('FIXO', 'POR_CONVIDADO')
    ),
    CONSTRAINT precos_pacote_valor_check CHECK (valor > 0),
    CONSTRAINT precos_pacote_categoria_check CHECK (
        categoria_horario IN ('PADRAO', 'NOBRE')
    ),
    CONSTRAINT precos_pacote_faixa_exata_uk
        UNIQUE NULLS NOT DISTINCT (
            tabela_preco_id,
            pacote_id,
            categoria_horario,
            convidados_min,
            convidados_max
        )
);

CREATE INDEX precos_pacote_busca_idx
    ON precos_pacote (
        tabela_preco_id,
        pacote_id,
        categoria_horario,
        convidados_min,
        convidados_max
    )
    WHERE ativo = true;

CREATE TRIGGER precos_pacote_atualizado_em_trg
BEFORE UPDATE ON precos_pacote
FOR EACH ROW
EXECUTE FUNCTION kidmais_set_atualizado_em();

CREATE OR REPLACE FUNCTION kidmais_validar_faixa_preco_pacote()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.ativo = true AND EXISTS (
        SELECT 1
          FROM precos_pacote p
         WHERE p.id <> NEW.id
           AND p.ativo = true
           AND p.tabela_preco_id = NEW.tabela_preco_id
           AND p.pacote_id = NEW.pacote_id
           AND p.categoria_horario = NEW.categoria_horario
           AND int4range(
                   p.convidados_min::integer,
                   p.convidados_max::integer,
                   '[]'
               ) && int4range(
                   NEW.convidados_min::integer,
                   NEW.convidados_max::integer,
                   '[]'
               )
    ) THEN
        RAISE EXCEPTION
            'Faixa de preço sobreposta para pacote %, tabela % e categoria %',
            NEW.pacote_id,
            NEW.tabela_preco_id,
            NEW.categoria_horario;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER precos_pacote_validar_faixa_trg
BEFORE INSERT OR UPDATE OF
    tabela_preco_id,
    pacote_id,
    convidados_min,
    convidados_max,
    categoria_horario,
    ativo
ON precos_pacote
FOR EACH ROW
EXECUTE FUNCTION kidmais_validar_faixa_preco_pacote();

-- -----------------------------------------------------------------------------
-- 4.1 Mini Festa — valor por convidado, mínimo de 30.
-- -----------------------------------------------------------------------------
WITH tabela AS (
    SELECT id FROM tabelas_preco WHERE codigo = 'COMERCIAL_2026_09'
),
pacote AS (
    SELECT id FROM pacotes WHERE codigo = 'MINI_FESTA'
)
INSERT INTO precos_pacote (
    tabela_preco_id,
    pacote_id,
    convidados_min,
    convidados_max,
    tipo_calculo,
    valor,
    categoria_horario,
    observacoes
)
SELECT
    t.id,
    p.id,
    30,
    150,
    'POR_CONVIDADO',
    170.00,
    'PADRAO',
    'R$ 170 por convidado, mínimo faturável de 30 convidados.'
FROM tabela t CROSS JOIN pacote p;

-- -----------------------------------------------------------------------------
-- 4.2 Festa Compacta — único valor automaticamente seguro nesta etapa.
-- A tabela comercial define base de 40 pessoas e valor inicial de R$ 6.490.
-- A faixa superior / regra de convidados excedentes não será inventada.
-- -----------------------------------------------------------------------------
WITH tabela AS (
    SELECT id FROM tabelas_preco WHERE codigo = 'COMERCIAL_2026_09'
),
pacote AS (
    SELECT id FROM pacotes WHERE codigo = 'COMPACTA'
)
INSERT INTO precos_pacote (
    tabela_preco_id,
    pacote_id,
    convidados_min,
    convidados_max,
    tipo_calculo,
    valor,
    categoria_horario,
    observacoes
)
SELECT
    t.id,
    p.id,
    40,
    40,
    'FIXO',
    6490.00,
    'PADRAO',
    'Base comercial confirmada para 40 convidados. Acima de 40 exige regra específica ainda não persistida.'
FROM tabela t CROSS JOIN pacote p;

-- -----------------------------------------------------------------------------
-- 4.3 Essencial / Completa / Premium — preço PADRAO por faixa.
-- O valor de cada linha representa o teto da faixa. Ex.: 51–60 usa a linha 60.
-- Valores confirmados como a base mais baixa para os horários regulares.
-- -----------------------------------------------------------------------------
WITH tabela AS (
    SELECT id FROM tabelas_preco WHERE codigo = 'COMERCIAL_2026_09'
),
faixas AS (
    SELECT * FROM (VALUES
        ('ESSENCIAL', 50,  50,  8490.00::numeric),
        ('ESSENCIAL', 51,  60,  9190.00::numeric),
        ('ESSENCIAL', 61,  70,  9890.00::numeric),
        ('ESSENCIAL', 71,  80, 10590.00::numeric),
        ('ESSENCIAL', 81,  90, 11290.00::numeric),
        ('ESSENCIAL', 91, 100, 11990.00::numeric),
        ('ESSENCIAL',101, 110, 12690.00::numeric),
        ('ESSENCIAL',111, 120, 13390.00::numeric),
        ('ESSENCIAL',121, 130, 14090.00::numeric),
        ('ESSENCIAL',131, 140, 14790.00::numeric),
        ('ESSENCIAL',141, 150, 15490.00::numeric),

        ('COMPLETA',   50,  50,  8990.00::numeric),
        ('COMPLETA',   51,  60,  9790.00::numeric),
        ('COMPLETA',   61,  70, 10590.00::numeric),
        ('COMPLETA',   71,  80, 11390.00::numeric),
        ('COMPLETA',   81,  90, 12190.00::numeric),
        ('COMPLETA',   91, 100, 12990.00::numeric),
        ('COMPLETA',  101, 110, 13790.00::numeric),
        ('COMPLETA',  111, 120, 14590.00::numeric),
        ('COMPLETA',  121, 130, 15390.00::numeric),
        ('COMPLETA',  131, 140, 16190.00::numeric),
        ('COMPLETA',  141, 150, 16990.00::numeric),

        ('PREMIUM',    50,  50,  9790.00::numeric),
        ('PREMIUM',    51,  60, 10690.00::numeric),
        ('PREMIUM',    61,  70, 11590.00::numeric),
        ('PREMIUM',    71,  80, 12490.00::numeric),
        ('PREMIUM',    81,  90, 13390.00::numeric),
        ('PREMIUM',    91, 100, 14290.00::numeric),
        ('PREMIUM',   101, 110, 15190.00::numeric),
        ('PREMIUM',   111, 120, 16090.00::numeric),
        ('PREMIUM',   121, 130, 16990.00::numeric),
        ('PREMIUM',   131, 140, 17890.00::numeric),
        ('PREMIUM',   141, 150, 18790.00::numeric)
    ) AS v(pacote_codigo, convidados_min, convidados_max, valor)
)
INSERT INTO precos_pacote (
    tabela_preco_id,
    pacote_id,
    convidados_min,
    convidados_max,
    tipo_calculo,
    valor,
    categoria_horario,
    observacoes
)
SELECT
    t.id,
    p.id,
    f.convidados_min,
    f.convidados_max,
    'FIXO',
    f.valor,
    'PADRAO',
    'Preço-base regular. Desconto de segunda a quinta, quando aplicável, é calculado separadamente.'
FROM tabela t
JOIN faixas f ON true
JOIN pacotes p ON p.codigo = f.pacote_codigo;

-- -----------------------------------------------------------------------------
-- 4.4 Categoria NOBRE
-- Os guias atuais confirmam os valores iniciais de Completa e Premium como
-- R$ 9.290 e R$ 10.690 para o contexto de preço mais alto informado pelo usuário.
-- A matriz completa de 60–150 convidados para NOBRE ainda precisa ser transcrita
-- da fonte comercial correta antes de esta migration deixar o estado DRAFT.
-- Portanto, NÃO seedamos uma matriz NOBRE incompleta nem reutilizamos números de
-- outro material como se fossem equivalentes.
-- -----------------------------------------------------------------------------

-- Pocket e Pizza Party também permanecem sem seed automático de preço nesta
-- migration: o primeiro não consta da tabela comercial atualizada utilizada como
-- fonte desta revisão e o Pizza Party é SOB_CONSULTA.

-- =============================================================================
-- 5. ADICIONAIS
-- =============================================================================
-- O catálogo é separado dos preços. Valores vigentes ficam em precos_adicional
-- e serão copiados futuramente para fechamento_adicionais para preservar histórico.

CREATE TABLE adicionais (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    codigo varchar(80) NOT NULL,
    nome text NOT NULL,
    descricao text,
    categoria varchar(40) NOT NULL,
    unidade_cobranca varchar(20) NOT NULL,
    ordem_exibicao smallint NOT NULL,
    ativo boolean NOT NULL DEFAULT true,
    observacoes text,
    criado_em timestamptz NOT NULL DEFAULT now(),
    atualizado_em timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT adicionais_codigo_uk UNIQUE (codigo),
    CONSTRAINT adicionais_codigo_nao_vazio CHECK (btrim(codigo) <> ''),
    CONSTRAINT adicionais_nome_nao_vazio CHECK (btrim(nome) <> ''),
    CONSTRAINT adicionais_categoria_nao_vazia CHECK (btrim(categoria) <> ''),
    CONSTRAINT adicionais_unidade_check CHECK (
        unidade_cobranca IN (
            'VALOR_FIXO',
            'CONVIDADO',
            'UNIDADE',
            'CENTO',
            'HORA',
            'PACOTE',
            'METRO'
        )
    ),
    CONSTRAINT adicionais_ordem_check CHECK (ordem_exibicao > 0)
);

CREATE INDEX adicionais_ativos_idx
    ON adicionais (categoria, ordem_exibicao, nome)
    WHERE ativo = true;

CREATE TRIGGER adicionais_atualizado_em_trg
BEFORE UPDATE ON adicionais
FOR EACH ROW
EXECUTE FUNCTION kidmais_set_atualizado_em();

INSERT INTO adicionais (
    codigo,
    nome,
    descricao,
    categoria,
    unidade_cobranca,
    ordem_exibicao
)
VALUES
    ('PENNE', 'Penne à bolonhesa e molho branco', NULL, 'BUFFET', 'PACOTE', 1),
    ('SALADA_PREMIUM', 'Salada premium', NULL, 'BUFFET', 'PACOTE', 2),
    ('CREPE_1_SABOR', 'Crepe — 1 sabor', NULL, 'BUFFET', 'PACOTE', 3),
    ('CREPE_2_SABORES', 'Crepe — 2 sabores', NULL, 'BUFFET', 'PACOTE', 4),
    ('PASTELZINHO', 'Pastelzinho de carne e queijo', NULL, 'BUFFET', 'PACOTE', 5),
    ('SORVETE', 'Sorvete', NULL, 'BUFFET', 'PACOTE', 6),
    ('EMPRATADO_PREMIUM', 'Empratado premium', NULL, 'BUFFET', 'PACOTE', 7),

    ('COMBO_ADULTOS', 'Combo Adultos', 'Penne + salada premium.', 'COMBO', 'PACOTE', 8),
    ('COMBO_LANCHINHOS', 'Combo Lanchinhos', 'Crepe + pastelzinho + sorvete.', 'COMBO', 'PACOTE', 9),

    ('MESA_CAFE', 'Mesa de café', NULL, 'MESA', 'PACOTE', 10),
    ('MESA_FRIOS', 'Mesa de frios', NULL, 'MESA', 'PACOTE', 11),
    ('MESA_FRUTAS', 'Mesa de frutas', NULL, 'MESA', 'PACOTE', 12),

    ('ARCO_BALAO_SIMPLES', 'Arco de balão simples', NULL, 'DECORACAO', 'PACOTE', 13),
    ('ARCO_BALAO_MEDIO', 'Arco de balão médio', NULL, 'DECORACAO', 'PACOTE', 14),
    ('ARCO_BALAO_GRANDE', 'Arco de balão grande', NULL, 'DECORACAO', 'PACOTE', 15),
    ('SEGUNDO_TEMA', '2º tema', NULL, 'DECORACAO', 'PACOTE', 16),
    ('PAINEL_REDONDO', 'Painel redondo', NULL, 'DECORACAO', 'PACOTE', 17),
    ('PAINEL_RETANGULAR_GRANDE', 'Painel retangular grande', NULL, 'DECORACAO', 'PACOTE', 18),
    ('CHAO_VIDRO', 'Chão de vidro', NULL, 'DECORACAO', 'PACOTE', 19),
    ('MONTAGEM_PERSONALIZADOS', 'Montagem de personalizados', NULL, 'DECORACAO', 'PACOTE', 20),

    ('COMBO_MESA_BONITA_SIMPLES', 'Combo Mesa Bonita — Simples', 'Arco simples + montagem de personalizados + complemento de mesa.', 'COMBO', 'PACOTE', 21),
    ('COMBO_MESA_BONITA_MEDIO', 'Combo Mesa Bonita — Médio', 'Arco médio + montagem de personalizados + complemento de mesa.', 'COMBO', 'PACOTE', 22),
    ('COMBO_MESA_BONITA_PREMIUM', 'Combo Mesa Bonita — Premium', 'Arco grande + montagem de personalizados + complemento de mesa.', 'COMBO', 'PACOTE', 23),
    ('VISUAL_PREMIUM', 'Visual Premium', 'Painel premium + arco grande + chão de vidro.', 'COMBO', 'PACOTE', 24),
    ('VISUAL_PREMIUM_PERSONALIZADOS', 'Visual Premium + personalizados', 'Visual Premium + montagem de personalizados.', 'COMBO', 'PACOTE', 25),
    ('VISUAL_PREMIUM_COMPLETO', 'Visual Premium completo', 'Visual Premium + personalizados + complemento extra de mesa.', 'COMBO', 'PACOTE', 26),

    ('DOCES_TRADICIONAIS_EXTRAS', 'Doces tradicionais extras', 'Além dos doces já contemplados no pacote.', 'EXTRA', 'CENTO', 27),
    ('BOMBOM', 'Bombom', NULL, 'EXTRA', 'UNIDADE', 28),
    ('LEMBRANCINHA_PERSONALIZADA', 'Lembrancinha personalizada', NULL, 'EXTRA', 'UNIDADE', 29),
    ('LEMBRANCINHA_PREMIUM', 'Lembrancinha premium', NULL, 'EXTRA', 'UNIDADE', 30),
    ('BEBIDA_ALCOOLICA', 'Taxa para bebida alcoólica', 'Taxa de estrutura e serviço.', 'BEBIDA', 'PACOTE', 31);

-- Lembrancinha extra simples (R$ 12 a R$ 15/unidade) não recebe seed nesta
-- versão porque a fonte vigente fornece intervalo, não um preço único calculável.

-- =============================================================================
-- 6. PREÇOS DOS ADICIONAIS
-- =============================================================================

CREATE TABLE precos_adicional (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tabela_preco_id uuid NOT NULL,
    adicional_id uuid NOT NULL,
    convidados_min smallint NOT NULL DEFAULT 1,
    convidados_max smallint,
    valor numeric(12,2) NOT NULL,
    observacoes text,
    ativo boolean NOT NULL DEFAULT true,
    criado_em timestamptz NOT NULL DEFAULT now(),
    atualizado_em timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT precos_adicional_tabela_fk
        FOREIGN KEY (tabela_preco_id)
        REFERENCES tabelas_preco(id)
        ON DELETE RESTRICT,
    CONSTRAINT precos_adicional_adicional_fk
        FOREIGN KEY (adicional_id)
        REFERENCES adicionais(id)
        ON DELETE RESTRICT,
    CONSTRAINT precos_adicional_convidados_min_check CHECK (convidados_min > 0),
    CONSTRAINT precos_adicional_convidados_intervalo_check CHECK (
        convidados_max IS NULL OR convidados_max >= convidados_min
    ),
    CONSTRAINT precos_adicional_valor_check CHECK (valor > 0),
    CONSTRAINT precos_adicional_faixa_exata_uk
        UNIQUE NULLS NOT DISTINCT (
            tabela_preco_id,
            adicional_id,
            convidados_min,
            convidados_max
        )
);

CREATE INDEX precos_adicional_busca_idx
    ON precos_adicional (
        tabela_preco_id,
        adicional_id,
        convidados_min,
        convidados_max
    )
    WHERE ativo = true;

CREATE TRIGGER precos_adicional_atualizado_em_trg
BEFORE UPDATE ON precos_adicional
FOR EACH ROW
EXECUTE FUNCTION kidmais_set_atualizado_em();

CREATE OR REPLACE FUNCTION kidmais_validar_faixa_preco_adicional()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.ativo = true AND EXISTS (
        SELECT 1
          FROM precos_adicional p
         WHERE p.id <> NEW.id
           AND p.ativo = true
           AND p.tabela_preco_id = NEW.tabela_preco_id
           AND p.adicional_id = NEW.adicional_id
           AND int4range(
                   p.convidados_min::integer,
                   p.convidados_max::integer,
                   '[]'
               ) && int4range(
                   NEW.convidados_min::integer,
                   NEW.convidados_max::integer,
                   '[]'
               )
    ) THEN
        RAISE EXCEPTION
            'Faixa de preço sobreposta para adicional % e tabela %',
            NEW.adicional_id,
            NEW.tabela_preco_id;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER precos_adicional_validar_faixa_trg
BEFORE INSERT OR UPDATE OF
    tabela_preco_id,
    adicional_id,
    convidados_min,
    convidados_max,
    ativo
ON precos_adicional
FOR EACH ROW
EXECUTE FUNCTION kidmais_validar_faixa_preco_adicional();

-- 6.1 Upgrades de buffet e combos por faixa.
-- Rótulos comerciais "até 50 / 60–80 / 90–110 / 120–150" são normalizados
-- para faixas contínuas 1–50 / 51–80 / 81–110 / 111–150, reproduzindo o
-- comportamento atual do cálculo do Fechamento para quantidades intermediárias.
WITH tabela AS (
    SELECT id FROM tabelas_preco WHERE codigo = 'COMERCIAL_2026_09'
),
faixas AS (
    SELECT * FROM (VALUES
        ('PENNE',                1,  50,  500.00::numeric),
        ('PENNE',               51,  80,  650.00::numeric),
        ('PENNE',               81, 110,  800.00::numeric),
        ('PENNE',              111, 150,  950.00::numeric),
        ('SALADA_PREMIUM',       1,  50,  450.00::numeric),
        ('SALADA_PREMIUM',      51,  80,  590.00::numeric),
        ('SALADA_PREMIUM',      81, 110,  690.00::numeric),
        ('SALADA_PREMIUM',     111, 150,  790.00::numeric),
        ('CREPE_1_SABOR',        1,  50,  350.00::numeric),
        ('CREPE_1_SABOR',       51,  80,  450.00::numeric),
        ('CREPE_1_SABOR',       81, 110,  550.00::numeric),
        ('CREPE_1_SABOR',      111, 150,  650.00::numeric),
        ('CREPE_2_SABORES',      1,  50,  590.00::numeric),
        ('CREPE_2_SABORES',     51,  80,  750.00::numeric),
        ('CREPE_2_SABORES',     81, 110,  890.00::numeric),
        ('CREPE_2_SABORES',    111, 150, 1050.00::numeric),
        ('PASTELZINHO',          1,  50,  350.00::numeric),
        ('PASTELZINHO',         51,  80,  450.00::numeric),
        ('PASTELZINHO',         81, 110,  550.00::numeric),
        ('PASTELZINHO',        111, 150,  650.00::numeric),
        ('SORVETE',              1,  50,  350.00::numeric),
        ('SORVETE',             51,  80,  450.00::numeric),
        ('SORVETE',             81, 110,  550.00::numeric),
        ('SORVETE',            111, 150,  650.00::numeric),
        ('EMPRATADO_PREMIUM',    1,  50,  750.00::numeric),
        ('EMPRATADO_PREMIUM',   51,  80,  950.00::numeric),
        ('EMPRATADO_PREMIUM',   81, 110, 1150.00::numeric),
        ('EMPRATADO_PREMIUM',  111, 150, 1390.00::numeric),
        ('COMBO_ADULTOS',        1,  50,  790.00::numeric),
        ('COMBO_ADULTOS',       51,  80,  990.00::numeric),
        ('COMBO_ADULTOS',       81, 110, 1190.00::numeric),
        ('COMBO_ADULTOS',      111, 150, 1390.00::numeric),
        ('COMBO_LANCHINHOS',     1,  50,  890.00::numeric),
        ('COMBO_LANCHINHOS',    51,  80, 1090.00::numeric),
        ('COMBO_LANCHINHOS',    81, 110, 1290.00::numeric),
        ('COMBO_LANCHINHOS',   111, 150, 1490.00::numeric)
    ) AS v(adicional_codigo, convidados_min, convidados_max, valor)
)
INSERT INTO precos_adicional (
    tabela_preco_id,
    adicional_id,
    convidados_min,
    convidados_max,
    valor,
    observacoes
)
SELECT
    t.id,
    a.id,
    f.convidados_min,
    f.convidados_max,
    f.valor,
    'Preço total do adicional para a faixa de convidados.'
FROM tabela t
JOIN faixas f ON true
JOIN adicionais a ON a.codigo = f.adicional_codigo;

-- 6.2 Mesas especiais por faixa de tamanho/convidados.
WITH tabela AS (
    SELECT id FROM tabelas_preco WHERE codigo = 'COMERCIAL_2026_09'
),
faixas AS (
    SELECT * FROM (VALUES
        ('MESA_CAFE',    1,  50, 590.00::numeric),
        ('MESA_CAFE',   51, 100, 790.00::numeric),
        ('MESA_CAFE',  101, 150, 990.00::numeric),
        ('MESA_FRIOS',   1,  50, 690.00::numeric),
        ('MESA_FRIOS',  51, 100, 890.00::numeric),
        ('MESA_FRIOS', 101, 150,1190.00::numeric),
        ('MESA_FRUTAS',  1,  50, 390.00::numeric),
        ('MESA_FRUTAS', 51, 100, 590.00::numeric),
        ('MESA_FRUTAS',101, 150, 790.00::numeric)
    ) AS v(adicional_codigo, convidados_min, convidados_max, valor)
)
INSERT INTO precos_adicional (
    tabela_preco_id,
    adicional_id,
    convidados_min,
    convidados_max,
    valor,
    observacoes
)
SELECT
    t.id,
    a.id,
    f.convidados_min,
    f.convidados_max,
    f.valor,
    'Tamanho derivado pela faixa de convidados.'
FROM tabela t
JOIN faixas f ON true
JOIN adicionais a ON a.codigo = f.adicional_codigo;

-- 6.3 Valores fixos / por unidade / por cento.
WITH tabela AS (
    SELECT id FROM tabelas_preco WHERE codigo = 'COMERCIAL_2026_09'
),
valores AS (
    SELECT * FROM (VALUES
        ('ARCO_BALAO_SIMPLES',            490.00::numeric),
        ('ARCO_BALAO_MEDIO',              690.00::numeric),
        ('ARCO_BALAO_GRANDE',             890.00::numeric),
        ('SEGUNDO_TEMA',                  600.00::numeric),
        ('PAINEL_REDONDO',                650.00::numeric),
        ('PAINEL_RETANGULAR_GRANDE',      850.00::numeric),
        ('CHAO_VIDRO',                    790.00::numeric),
        ('MONTAGEM_PERSONALIZADOS',       180.00::numeric),
        ('COMBO_MESA_BONITA_SIMPLES',     790.00::numeric),
        ('COMBO_MESA_BONITA_MEDIO',      1190.00::numeric),
        ('COMBO_MESA_BONITA_PREMIUM',    1690.00::numeric),
        ('VISUAL_PREMIUM',               1890.00::numeric),
        ('VISUAL_PREMIUM_PERSONALIZADOS',2190.00::numeric),
        ('VISUAL_PREMIUM_COMPLETO',      2490.00::numeric),
        ('DOCES_TRADICIONAIS_EXTRAS',     180.00::numeric),
        ('BOMBOM',                          7.00::numeric),
        ('LEMBRANCINHA_PERSONALIZADA',      18.00::numeric),
        ('LEMBRANCINHA_PREMIUM',            25.00::numeric)
    ) AS v(adicional_codigo, valor)
)
INSERT INTO precos_adicional (
    tabela_preco_id,
    adicional_id,
    convidados_min,
    convidados_max,
    valor,
    observacoes
)
SELECT
    t.id,
    a.id,
    1,
    150,
    v.valor,
    'Valor vigente conforme unidade de cobrança cadastrada no adicional.'
FROM tabela t
JOIN valores v ON true
JOIN adicionais a ON a.codigo = v.adicional_codigo;

-- 6.4 Bebida alcoólica — taxa de estrutura/serviço por faixa.
WITH tabela AS (
    SELECT id FROM tabelas_preco WHERE codigo = 'COMERCIAL_2026_09'
),
faixas AS (
    SELECT * FROM (VALUES
        (  1,  80, 200.00::numeric),
        ( 81, 120, 300.00::numeric),
        (121, 150, 400.00::numeric)
    ) AS v(convidados_min, convidados_max, valor)
),
adicional AS (
    SELECT id FROM adicionais WHERE codigo = 'BEBIDA_ALCOOLICA'
)
INSERT INTO precos_adicional (
    tabela_preco_id,
    adicional_id,
    convidados_min,
    convidados_max,
    valor,
    observacoes
)
SELECT
    t.id,
    a.id,
    f.convidados_min,
    f.convidados_max,
    f.valor,
    'Taxa de estrutura e serviço para bebida alcoólica.'
FROM tabela t CROSS JOIN adicional a CROSS JOIN faixas f;

-- =============================================================================
-- 7. ELEGIBILIDADE COMERCIAL POR PACOTE
-- =============================================================================
-- Disponibilidade física e elegibilidade comercial permanecem conceitos distintos.

CREATE TABLE regras_disponibilidade_pacote (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    pacote_id uuid NOT NULL,
    dia_semana smallint NOT NULL,
    configuracao_agenda_id uuid NOT NULL,
    estado varchar(20) NOT NULL,
    vigencia_inicio date NOT NULL,
    vigencia_fim date,
    ativo boolean NOT NULL DEFAULT true,
    observacoes text,
    criado_em timestamptz NOT NULL DEFAULT now(),
    atualizado_em timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT regras_disp_pacote_pacote_fk
        FOREIGN KEY (pacote_id)
        REFERENCES pacotes(id)
        ON DELETE RESTRICT,
    CONSTRAINT regras_disp_pacote_config_fk
        FOREIGN KEY (configuracao_agenda_id)
        REFERENCES configuracao_agenda(id)
        ON DELETE RESTRICT,
    CONSTRAINT regras_disp_pacote_dia_check CHECK (dia_semana BETWEEN 1 AND 7),
    CONSTRAINT regras_disp_pacote_estado_check CHECK (
        estado IN ('DISPONIVEL', 'INDISPONIVEL', 'SOB_CONSULTA')
    ),
    CONSTRAINT regras_disp_pacote_vigencia_check CHECK (
        vigencia_fim IS NULL OR vigencia_fim >= vigencia_inicio
    ),
    CONSTRAINT regras_disp_pacote_inicio_uk UNIQUE (
        pacote_id,
        dia_semana,
        configuracao_agenda_id,
        vigencia_inicio
    )
);

CREATE INDEX regras_disp_pacote_busca_idx
    ON regras_disponibilidade_pacote (
        pacote_id,
        dia_semana,
        configuracao_agenda_id,
        vigencia_inicio,
        vigencia_fim
    )
    WHERE ativo = true;

CREATE TRIGGER regras_disp_pacote_atualizado_em_trg
BEFORE UPDATE ON regras_disponibilidade_pacote
FOR EACH ROW
EXECUTE FUNCTION kidmais_set_atualizado_em();

CREATE OR REPLACE FUNCTION kidmais_validar_vigencia_regra_disponibilidade_pacote()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.ativo = true AND EXISTS (
        SELECT 1
          FROM regras_disponibilidade_pacote r
         WHERE r.id <> NEW.id
           AND r.ativo = true
           AND r.pacote_id = NEW.pacote_id
           AND r.dia_semana = NEW.dia_semana
           AND r.configuracao_agenda_id = NEW.configuracao_agenda_id
           AND daterange(r.vigencia_inicio, r.vigencia_fim, '[]')
               && daterange(NEW.vigencia_inicio, NEW.vigencia_fim, '[]')
    ) THEN
        RAISE EXCEPTION
            'Vigência de regra de pacote sobreposta para pacote %, dia % e configuração %',
            NEW.pacote_id,
            NEW.dia_semana,
            NEW.configuracao_agenda_id;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER regras_disp_pacote_validar_vigencia_trg
BEFORE INSERT OR UPDATE OF
    pacote_id,
    dia_semana,
    configuracao_agenda_id,
    vigencia_inicio,
    vigencia_fim,
    ativo
ON regras_disponibilidade_pacote
FOR EACH ROW
EXECUTE FUNCTION kidmais_validar_vigencia_regra_disponibilidade_pacote();

WITH dias AS (
    SELECT generate_series(1, 7)::smallint AS dia_semana
),
pacotes_ref AS (
    SELECT id, codigo
      FROM pacotes
     WHERE codigo IN (
        'POCKET',
        'MINI_FESTA',
        'COMPACTA',
        'ESSENCIAL',
        'COMPLETA',
        'PREMIUM',
        'PIZZA_PARTY'
     )
),
configs AS (
    SELECT id, codigo
      FROM configuracao_agenda
     WHERE codigo IN ('TURNO_1', 'TURNO_2')
       AND ativo = true
)
INSERT INTO regras_disponibilidade_pacote (
    pacote_id,
    dia_semana,
    configuracao_agenda_id,
    estado,
    vigencia_inicio,
    observacoes
)
SELECT
    p.id,
    d.dia_semana,
    c.id,
    CASE
        WHEN p.codigo = 'POCKET' THEN
            CASE
                WHEN d.dia_semana BETWEEN 1 AND 4 THEN 'DISPONIVEL'
                ELSE 'INDISPONIVEL'
            END
        WHEN p.codigo = 'MINI_FESTA' THEN
            CASE
                WHEN d.dia_semana BETWEEN 1 AND 4 THEN 'DISPONIVEL'
                WHEN d.dia_semana = 5 AND c.codigo = 'TURNO_1' THEN 'DISPONIVEL'
                ELSE 'INDISPONIVEL'
            END
        WHEN p.codigo = 'COMPACTA' THEN
            CASE
                WHEN d.dia_semana = 6 AND c.codigo = 'TURNO_2' THEN 'INDISPONIVEL'
                ELSE 'DISPONIVEL'
            END
        WHEN p.codigo = 'PIZZA_PARTY' THEN 'SOB_CONSULTA'
        ELSE 'DISPONIVEL'
    END,
    DATE '2026-09-07',
    'Matriz regular oficial inicial do módulo Disponibilidade/Fechamento.'
FROM pacotes_ref p
CROSS JOIN dias d
CROSS JOIN configs c;

-- =============================================================================
-- 8. REGRAS DE DESCONTO AUTOMÁTICO DO PACOTE
-- =============================================================================
-- Mantém o comportamento funcional atual do Fechamento:
-- - 15% de desconto de segunda a quinta;
-- - incide somente sobre o valor do pacote;
-- - adicionais permanecem fora do desconto;
-- - regra atualmente aplicada a Essencial, Completa, Premium e Pizza Party.
--
-- O desconto é separado de precos_pacote para preservar o valor de tabela.
-- Desconto manual específico por data/turno será persistido em estrutura própria
-- quando a administração comercial correspondente for implementada.

CREATE TABLE regras_desconto_pacote (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    pacote_id uuid NOT NULL,
    dia_semana smallint NOT NULL,
    configuracao_agenda_id uuid,
    percentual numeric(5,2) NOT NULL,
    base_calculo varchar(20) NOT NULL DEFAULT 'PACOTE',
    codigo varchar(50) NOT NULL,
    titulo text,
    prioridade smallint NOT NULL DEFAULT 100,
    vigencia_inicio date NOT NULL,
    vigencia_fim date,
    ativo boolean NOT NULL DEFAULT true,
    observacoes text,
    criado_em timestamptz NOT NULL DEFAULT now(),
    atualizado_em timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT regras_desconto_pacote_pacote_fk
        FOREIGN KEY (pacote_id)
        REFERENCES pacotes(id)
        ON DELETE RESTRICT,
    CONSTRAINT regras_desconto_pacote_config_fk
        FOREIGN KEY (configuracao_agenda_id)
        REFERENCES configuracao_agenda(id)
        ON DELETE RESTRICT,
    CONSTRAINT regras_desconto_pacote_dia_check
        CHECK (dia_semana BETWEEN 1 AND 7),
    CONSTRAINT regras_desconto_pacote_percentual_check
        CHECK (percentual > 0 AND percentual <= 100),
    CONSTRAINT regras_desconto_pacote_base_check
        CHECK (base_calculo IN ('PACOTE')),
    CONSTRAINT regras_desconto_pacote_codigo_nao_vazio
        CHECK (btrim(codigo) <> ''),
    CONSTRAINT regras_desconto_pacote_prioridade_check
        CHECK (prioridade > 0),
    CONSTRAINT regras_desconto_pacote_vigencia_check
        CHECK (vigencia_fim IS NULL OR vigencia_fim >= vigencia_inicio),
    CONSTRAINT regras_desconto_pacote_inicio_uk
        UNIQUE NULLS NOT DISTINCT (
            pacote_id,
            dia_semana,
            configuracao_agenda_id,
            codigo,
            vigencia_inicio
        )
);

CREATE INDEX regras_desconto_pacote_busca_idx
    ON regras_desconto_pacote (
        pacote_id,
        dia_semana,
        configuracao_agenda_id,
        prioridade,
        vigencia_inicio,
        vigencia_fim
    )
    WHERE ativo = true;

CREATE TRIGGER regras_desconto_pacote_atualizado_em_trg
BEFORE UPDATE ON regras_desconto_pacote
FOR EACH ROW
EXECUTE FUNCTION kidmais_set_atualizado_em();

CREATE OR REPLACE FUNCTION kidmais_validar_vigencia_regra_desconto_pacote()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.ativo = true AND EXISTS (
        SELECT 1
          FROM regras_desconto_pacote r
         WHERE r.id <> NEW.id
           AND r.ativo = true
           AND r.pacote_id = NEW.pacote_id
           AND r.dia_semana = NEW.dia_semana
           AND r.configuracao_agenda_id IS NOT DISTINCT FROM NEW.configuracao_agenda_id
           AND r.codigo = NEW.codigo
           AND daterange(r.vigencia_inicio, r.vigencia_fim, '[]')
               && daterange(NEW.vigencia_inicio, NEW.vigencia_fim, '[]')
    ) THEN
        RAISE EXCEPTION
            'Vigência de desconto sobreposta para pacote %, dia %, configuração % e código %',
            NEW.pacote_id,
            NEW.dia_semana,
            NEW.configuracao_agenda_id,
            NEW.codigo;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER regras_desconto_pacote_validar_vigencia_trg
BEFORE INSERT OR UPDATE OF
    pacote_id,
    dia_semana,
    configuracao_agenda_id,
    codigo,
    vigencia_inicio,
    vigencia_fim,
    ativo
ON regras_desconto_pacote
FOR EACH ROW
EXECUTE FUNCTION kidmais_validar_vigencia_regra_desconto_pacote();

WITH dias_uteis AS (
    SELECT generate_series(1, 4)::smallint AS dia_semana
),
pacotes_desconto AS (
    SELECT id
      FROM pacotes
     WHERE codigo IN ('ESSENCIAL', 'COMPLETA', 'PREMIUM', 'PIZZA_PARTY')
)
INSERT INTO regras_desconto_pacote (
    pacote_id,
    dia_semana,
    configuracao_agenda_id,
    percentual,
    base_calculo,
    codigo,
    titulo,
    prioridade,
    vigencia_inicio,
    observacoes
)
SELECT
    p.id,
    d.dia_semana,
    NULL,
    15.00,
    'PACOTE',
    'DIA_UTIL_15',
    '15% de desconto de segunda a quinta',
    100,
    DATE '2026-09-07',
    'Aplicado sobre o preço PADRAO do pacote. Adicionais não recebem este desconto.'
FROM pacotes_desconto p
CROSS JOIN dias_uteis d;

COMMIT;
