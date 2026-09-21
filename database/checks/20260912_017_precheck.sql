DO $$
DECLARE
    pocket_id uuid;
    turno_id uuid;
    estado_atual text;
    inicio_atual date;
    fim_atual date;
    estado_novo text;
BEGIN
    IF to_regclass('public.regras_disponibilidade_pacote') IS NULL
       OR to_regclass('public.pacotes') IS NULL
       OR to_regclass('public.configuracao_agenda') IS NULL THEN
        RAISE EXCEPTION 'Precheck 017: estruturas comerciais obrigatórias ausentes.';
    END IF;

    SELECT id INTO STRICT pocket_id FROM public.pacotes WHERE codigo = 'POCKET' AND ativo;
    SELECT id INTO STRICT turno_id FROM public.configuracao_agenda WHERE codigo = 'TURNO_1' AND ativo;

    SELECT estado, vigencia_inicio, vigencia_fim
      INTO estado_novo, inicio_atual, fim_atual
      FROM public.regras_disponibilidade_pacote
     WHERE pacote_id = pocket_id
       AND dia_semana = 5
       AND configuracao_agenda_id = turno_id
       AND vigencia_inicio = DATE '2026-09-12'
       AND ativo;

    IF FOUND THEN
        IF estado_novo <> 'DISPONIVEL' OR fim_atual IS NOT NULL THEN
            RAISE EXCEPTION 'Precheck 017: regra nova existente diverge do estado canônico.';
        END IF;
        IF NOT EXISTS (
            SELECT 1 FROM public.regras_disponibilidade_pacote
             WHERE pacote_id = pocket_id AND dia_semana = 5
               AND configuracao_agenda_id = turno_id AND ativo
               AND estado = 'INDISPONIVEL' AND vigencia_fim = DATE '2026-09-11'
        ) THEN
            RAISE EXCEPTION 'Precheck 017: regra histórica anterior não foi preservada.';
        END IF;
        RETURN;
    END IF;

    SELECT estado, vigencia_inicio, vigencia_fim
      INTO STRICT estado_atual, inicio_atual, fim_atual
      FROM public.regras_disponibilidade_pacote
     WHERE pacote_id = pocket_id
       AND dia_semana = 5
       AND configuracao_agenda_id = turno_id
       AND ativo
       AND DATE '2026-09-12' BETWEEN vigencia_inicio AND COALESCE(vigencia_fim, 'infinity'::date);

    IF estado_atual <> 'INDISPONIVEL' OR inicio_atual <> DATE '2026-09-07' OR fim_atual IS NOT NULL THEN
        RAISE EXCEPTION 'Precheck 017: regra anterior do Pocket sexta/TURNO_1 diverge do estado esperado.';
    END IF;
END $$;
