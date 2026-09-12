BEGIN;

-- Kidmais Manager — Disponibilidade
-- Migration 005: configuração operacional da agenda e bloqueios administrativos.
--
-- A disponibilidade NÃO é materializada em slots futuros. Os horários candidatos
-- são calculados pelo serviço a partir de configuracao_agenda.

CREATE TABLE configuracao_agenda (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    codigo varchar(40) NOT NULL,
    nome varchar(80) NOT NULL,
    horario_inicio_padrao time NOT NULL,
    horario_fim_padrao time NOT NULL,
    tolerancia_inicio_minutos smallint NOT NULL DEFAULT 30,
    passo_inicio_minutos smallint NOT NULL DEFAULT 30,
    ordem_exibicao smallint NOT NULL,
    ativo boolean NOT NULL DEFAULT true,
    criado_em timestamptz NOT NULL DEFAULT now(),
    atualizado_em timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT configuracao_agenda_codigo_uk UNIQUE (codigo),
    CONSTRAINT configuracao_agenda_codigo_nao_vazio CHECK (btrim(codigo) <> ''),
    CONSTRAINT configuracao_agenda_nome_nao_vazio CHECK (btrim(nome) <> ''),
    CONSTRAINT configuracao_agenda_intervalo_check CHECK (
        horario_fim_padrao > horario_inicio_padrao
    ),
    CONSTRAINT configuracao_agenda_tolerancia_check CHECK (
        tolerancia_inicio_minutos BETWEEN 0 AND 180
    ),
    CONSTRAINT configuracao_agenda_passo_check CHECK (
        passo_inicio_minutos BETWEEN 1 AND 180
    ),
    CONSTRAINT configuracao_agenda_passo_compativel_check CHECK (
        tolerancia_inicio_minutos = 0
        OR mod(tolerancia_inicio_minutos, passo_inicio_minutos) = 0
    ),
    CONSTRAINT configuracao_agenda_ordem_check CHECK (ordem_exibicao > 0)
);

CREATE INDEX configuracao_agenda_ativos_idx
    ON configuracao_agenda (ordem_exibicao)
    WHERE ativo = true;

CREATE TRIGGER configuracao_agenda_atualizado_em_trg
BEFORE UPDATE ON configuracao_agenda
FOR EACH ROW
EXECUTE FUNCTION kidmais_set_atualizado_em();

CREATE TABLE bloqueios_agenda (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    data date NOT NULL,
    dia_inteiro boolean NOT NULL DEFAULT false,
    horario_inicio time,
    horario_fim time,
    motivo text NOT NULL,
    observacoes text,
    criado_por_usuario_id uuid,
    ativo boolean NOT NULL DEFAULT true,
    criado_em timestamptz NOT NULL DEFAULT now(),
    atualizado_em timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT bloqueios_agenda_motivo_nao_vazio CHECK (btrim(motivo) <> ''),
    CONSTRAINT bloqueios_agenda_periodo_check CHECK (
        (
            dia_inteiro = true
            AND horario_inicio IS NULL
            AND horario_fim IS NULL
        )
        OR
        (
            dia_inteiro = false
            AND horario_inicio IS NOT NULL
            AND horario_fim IS NOT NULL
            AND horario_fim > horario_inicio
        )
    )
);

CREATE INDEX bloqueios_agenda_data_ativos_idx
    ON bloqueios_agenda (data)
    WHERE ativo = true;

CREATE INDEX bloqueios_agenda_intervalo_ativos_idx
    ON bloqueios_agenda (data, horario_inicio, horario_fim)
    WHERE ativo = true AND dia_inteiro = false;

CREATE TRIGGER bloqueios_agenda_atualizado_em_trg
BEFORE UPDATE ON bloqueios_agenda
FOR EACH ROW
EXECUTE FUNCTION kidmais_set_atualizado_em();

INSERT INTO configuracao_agenda (
    codigo,
    nome,
    horario_inicio_padrao,
    horario_fim_padrao,
    tolerancia_inicio_minutos,
    passo_inicio_minutos,
    ordem_exibicao
)
VALUES
    ('TURNO_1', 'Primeiro horário', '11:00', '15:00', 30, 30, 1),
    ('TURNO_2', 'Segundo horário',  '17:00', '21:00', 30, 30, 2);

COMMIT;
