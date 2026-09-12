BEGIN;

LOCK TABLE public.regras_disponibilidade_pacote IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
    pocket_id uuid;
    turno_id uuid;
    regra_anterior_id uuid;
    regra_nova_id uuid;
BEGIN
    SELECT id INTO STRICT pocket_id FROM public.pacotes WHERE codigo = 'POCKET' AND ativo;
    SELECT id INTO STRICT turno_id FROM public.configuracao_agenda WHERE codigo = 'TURNO_1' AND ativo;

    SELECT id INTO regra_nova_id
      FROM public.regras_disponibilidade_pacote
     WHERE pacote_id = pocket_id AND dia_semana = 5
       AND configuracao_agenda_id = turno_id AND ativo
       AND vigencia_inicio = DATE '2026-09-12'
       AND vigencia_fim IS NULL AND estado = 'DISPONIVEL'
     FOR UPDATE;

    IF regra_nova_id IS NULL THEN
        IF EXISTS (
            SELECT 1 FROM public.regras_disponibilidade_pacote
             WHERE pacote_id = pocket_id AND dia_semana = 5
               AND configuracao_agenda_id = turno_id AND ativo
               AND vigencia_inicio = DATE '2026-09-07'
               AND vigencia_fim IS NULL AND estado = 'INDISPONIVEL'
        ) THEN
            RETURN;
        END IF;
        RAISE EXCEPTION 'Rollback 017: estado não reconhecido; operação recusada.';
    END IF;

    IF EXISTS (
        SELECT 1 FROM public.fechamentos
         WHERE pacote_id = pocket_id
           AND configuracao_agenda_id = turno_id
           AND data_evento >= DATE '2026-09-12'
           AND EXTRACT(ISODOW FROM data_evento) = 5
    ) THEN
        RAISE EXCEPTION 'Rollback 017 recusado: existem Fechamentos Pocket beneficiados pela regra de sexta/TURNO_1.';
    END IF;

    SELECT id INTO STRICT regra_anterior_id
      FROM public.regras_disponibilidade_pacote
     WHERE pacote_id = pocket_id AND dia_semana = 5
       AND configuracao_agenda_id = turno_id AND ativo
       AND vigencia_inicio = DATE '2026-09-07'
       AND vigencia_fim = DATE '2026-09-11'
       AND estado = 'INDISPONIVEL'
     FOR UPDATE;

    DELETE FROM public.regras_disponibilidade_pacote WHERE id = regra_nova_id;
    UPDATE public.regras_disponibilidade_pacote SET vigencia_fim = NULL WHERE id = regra_anterior_id;
END $$;

COMMIT;
