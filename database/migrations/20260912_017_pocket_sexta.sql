BEGIN;

LOCK TABLE public.regras_disponibilidade_pacote IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
    pocket_id uuid;
    turno_id uuid;
    regra_anterior_id uuid;
BEGIN
    SELECT id INTO STRICT pocket_id FROM public.pacotes WHERE codigo = 'POCKET' AND ativo;
    SELECT id INTO STRICT turno_id FROM public.configuracao_agenda WHERE codigo = 'TURNO_1' AND ativo;

    IF EXISTS (
        SELECT 1 FROM public.regras_disponibilidade_pacote
         WHERE pacote_id = pocket_id AND dia_semana = 5
           AND configuracao_agenda_id = turno_id AND ativo
           AND vigencia_inicio = DATE '2026-09-12'
           AND vigencia_fim IS NULL AND estado = 'DISPONIVEL'
    ) THEN
        IF NOT EXISTS (
            SELECT 1 FROM public.regras_disponibilidade_pacote
             WHERE pacote_id = pocket_id AND dia_semana = 5
               AND configuracao_agenda_id = turno_id AND ativo
               AND vigencia_inicio = DATE '2026-09-07'
               AND vigencia_fim = DATE '2026-09-11'
               AND estado = 'INDISPONIVEL'
        ) THEN
            RAISE EXCEPTION 'Migration 017: aplicação parcial ou regra histórica divergente.';
        END IF;
        RETURN;
    END IF;

    SELECT id INTO STRICT regra_anterior_id
      FROM public.regras_disponibilidade_pacote
     WHERE pacote_id = pocket_id AND dia_semana = 5
       AND configuracao_agenda_id = turno_id AND ativo
       AND vigencia_inicio = DATE '2026-09-07'
       AND vigencia_fim IS NULL AND estado = 'INDISPONIVEL'
     FOR UPDATE;

    IF EXISTS (
        SELECT 1 FROM public.regras_disponibilidade_pacote
         WHERE pacote_id = pocket_id AND dia_semana = 5
           AND configuracao_agenda_id = turno_id AND ativo
           AND id <> regra_anterior_id
           AND daterange(vigencia_inicio, vigencia_fim, '[]') && daterange(DATE '2026-09-12', NULL, '[]')
    ) THEN
        RAISE EXCEPTION 'Migration 017: existe vigência concorrente para Pocket sexta/TURNO_1.';
    END IF;

    UPDATE public.regras_disponibilidade_pacote
       SET vigencia_fim = DATE '2026-09-11'
     WHERE id = regra_anterior_id;

    INSERT INTO public.regras_disponibilidade_pacote (
        pacote_id, dia_semana, configuracao_agenda_id, estado,
        vigencia_inicio, vigencia_fim, ativo, observacoes
    ) VALUES (
        pocket_id, 5, turno_id, 'DISPONIVEL',
        DATE '2026-09-12', NULL, true,
        'Kidmais Pocket disponível às sextas-feiras no primeiro horário, das 11h às 15h.'
    );
END $$;

COMMIT;
