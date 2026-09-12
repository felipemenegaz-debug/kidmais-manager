DO $$
DECLARE
    pocket_id uuid;
    turno_id uuid;
BEGIN
    SELECT id INTO STRICT pocket_id FROM public.pacotes WHERE codigo = 'POCKET' AND ativo;
    SELECT id INTO STRICT turno_id FROM public.configuracao_agenda WHERE codigo = 'TURNO_1' AND ativo;

    IF (SELECT count(*) FROM public.regras_disponibilidade_pacote
         WHERE pacote_id = pocket_id AND dia_semana = 5
           AND configuracao_agenda_id = turno_id AND ativo
           AND vigencia_inicio = DATE '2026-09-07'
           AND vigencia_fim = DATE '2026-09-11'
           AND estado = 'INDISPONIVEL') <> 1 THEN
        RAISE EXCEPTION 'Postcheck 017: regra histórica anterior inválida.';
    END IF;

    IF (SELECT count(*) FROM public.regras_disponibilidade_pacote
         WHERE pacote_id = pocket_id AND dia_semana = 5
           AND configuracao_agenda_id = turno_id AND ativo
           AND vigencia_inicio = DATE '2026-09-12'
           AND vigencia_fim IS NULL
           AND estado = 'DISPONIVEL') <> 1 THEN
        RAISE EXCEPTION 'Postcheck 017: regra vigente do Pocket sexta/TURNO_1 inválida.';
    END IF;

    IF EXISTS (
        SELECT 1
          FROM public.regras_disponibilidade_pacote a
          JOIN public.regras_disponibilidade_pacote b ON a.id < b.id
         WHERE a.pacote_id = pocket_id AND b.pacote_id = pocket_id
           AND a.dia_semana = 5 AND b.dia_semana = 5
           AND a.configuracao_agenda_id = turno_id AND b.configuracao_agenda_id = turno_id
           AND a.ativo AND b.ativo
           AND daterange(a.vigencia_inicio, a.vigencia_fim, '[]') && daterange(b.vigencia_inicio, b.vigencia_fim, '[]')
    ) THEN
        RAISE EXCEPTION 'Postcheck 017: vigências sobrepostas.';
    END IF;
END $$;
