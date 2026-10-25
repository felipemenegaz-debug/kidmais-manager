-- Precheck da 100 (somente leitura): 093/094 presentes e a regra de conflito com o corpo EXATO da 094 (sem 098, sem 100).
DO $$
BEGIN
  IF to_regclass('public.agenda_escopo_config') IS NULL OR to_regprocedure('public.kidmais094_ocupacoes(date,date)') IS NULL
    OR to_regprocedure('public.kidmais094_conflito_ocupacao(uuid,date,time without time zone,time without time zone,uuid,uuid,uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION '100 precheck: 093/094 ausentes';
  END IF;
  IF (SELECT encode(sha256(convert_to(replace(prosrc, E'\r', ''), 'UTF8')), 'hex') FROM pg_proc WHERE oid = to_regprocedure('public.kidmais094_conflito_ocupacao(uuid,date,time without time zone,time without time zone,uuid,uuid,uuid,uuid)')) IS DISTINCT FROM 'b6aac1c0b99ed64f4dca94fe5d886e5d5892b82888325010e02adc850def8cf6' THEN
    RAISE EXCEPTION '100 precheck: corpo da regra de conflito diferente do da 094 (100 já aplicada ou 098 presente)';
  END IF;
END $$;
