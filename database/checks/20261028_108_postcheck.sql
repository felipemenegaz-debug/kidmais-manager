-- Postcheck da 108 (somente leitura): marcador, colunas, CHECK validado, 6 gatilhos e os três corpos (regra de
-- conflito da 108; validações idênticas às do conjunto '098' do manifesto da Festa).
DO $$
BEGIN
  IF to_regprocedure('public.kidmais108_instalada()') IS NULL OR to_regprocedure('public.kidmais098_hoje()') IS NULL
     OR (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'agenda_saloes'
          AND column_name IN ('combinado', 'membros')) <> 2
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.agenda_saloes'::regclass AND conname = 'agenda_saloes_098_membros_check' AND convalidated)
     OR (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled = 'O' AND tgname IN (
          'agenda_saloes_098_guarda_trg', 'agenda_saloes_098_combinado_trg', 'agenda_saloes_098_combinado_diferido',
          'agenda_saloes_098_truncate_trg', 'contratos_098_guarda_trg', 'contratos_098_truncate_trg')) <> 6
     OR EXISTS (SELECT 1 FROM (VALUES
          ('kidmais094_conflito_ocupacao(uuid,date,time without time zone,time without time zone,uuid,uuid,uuid,uuid)', '06a387fe9c40ceca6a4021b1f9676b76ee92592a2cc241705f1201a40cc97537'),
          ('kidmais019_validar_contrato()', '13095fc87c52c3970f9cfad1c5bcef77d3e860904f71b39948de0335b4e76c21'),
          ('kidmais_validar_agenda_revisao()', '8476ec76d2ae8af4f7fbbdba595b0fd82b8060c76be4d2d915a47451f11f9e24')) AS e(f, h)
        WHERE (SELECT encode(sha256(convert_to(replace(prosrc, E'\r', ''), 'UTF8')), 'hex') FROM pg_proc WHERE oid = to_regprocedure('public.' || e.f))
              IS DISTINCT FROM e.h) THEN
    RAISE EXCEPTION '108 postcheck: instalação incompleta ou corpo divergente';
  END IF;
END $$;
