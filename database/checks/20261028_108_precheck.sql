-- Precheck da 108 (somente leitura). Gerado de database/migrations/20261028_108_saloes_combinados.sql.
DO $$
BEGIN
  IF to_regclass('public.agenda_saloes') IS NULL OR to_regclass('public.contratos') IS NULL
    OR to_regprocedure('public.kidmais094_ocupacoes(date,date)') IS NULL
    OR to_regprocedure('public.kidmais094_conflito_ocupacao(uuid,date,time without time zone,time without time zone,uuid,uuid,uuid,uuid)') IS NULL
    -- 102 (conteúdo), 104 (hash v2), 106 (preferido) e 107 (reparo da agenda) aplicadas.
    OR to_regclass('public.agenda_salao_fotos') IS NULL OR to_regprocedure('public.kidmais102_salao_conteudo()') IS NULL
    OR NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('public.fechamento_revisoes') AND attname = 'hash_versao' AND NOT attisdropped)
    OR NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('public.fechamentos') AND attname = 'salao_preferido_id' AND NOT attisdropped)
    OR to_regclass('public.kidmais107_reparos') IS NULL THEN
    RAISE EXCEPTION '108: precheck falhou (093/094/100/102/104/106/107 ausentes); nada alterado';
  END IF;
  -- Nem a 098 histórica nem a 108 (completa ou parcial).
  IF to_regprocedure('public.kidmais098_hoje()') IS NOT NULL OR to_regprocedure('public.kidmais108_instalada()') IS NOT NULL
    OR to_regprocedure('public.kidmais098_saloes_cruzam(uuid,uuid)') IS NOT NULL OR to_regprocedure('public.kidmais098_salao_elegivel(uuid)') IS NOT NULL
    OR EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'agenda_saloes'
                AND column_name IN ('combinado', 'membros')) THEN
    RAISE EXCEPTION '108: precheck falhou (098 histórica ou 108 anterior/parcial presente); nada alterado';
  END IF;
  -- Corpos atuais: regra de conflito da 100 e as duas validações da 094 (as que esta substitui).
  IF EXISTS (SELECT 1 FROM (VALUES
        ('kidmais094_conflito_ocupacao(uuid,date,time without time zone,time without time zone,uuid,uuid,uuid,uuid)', '805cd427a7cc7a725fb3bdfb4fd050f04e618131104fcfc0678a0ddadd5b4bdb'),
        ('kidmais019_validar_contrato()', '4d462947bc173967fe9ff059a4aa857bd068502c042ae81a97c918e3362bf43e'),
        ('kidmais_validar_agenda_revisao()', '951825ad597495b477963ebb74df0120c1e8f4c59d39f6b7b32f53e5baaea821')) AS e(f, h)
      WHERE (SELECT encode(sha256(convert_to(replace(prosrc, E'\r', ''), 'UTF8')), 'hex') FROM pg_proc WHERE oid = to_regprocedure('public.' || e.f))
            IS DISTINCT FROM e.h) THEN
    RAISE EXCEPTION '108: precheck falhou (corpos da 100/094 divergentes); nada alterado';
  END IF;
  -- Invariante desde o início: nenhuma ocupação de hoje em diante (São Paulo) em salão inativo.
  IF EXISTS (SELECT 1 FROM kidmais094_ocupacoes((clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date, 'infinity'::date) o
               JOIN agenda_saloes s ON s.id = o.salao_id WHERE NOT s.ativo) THEN
    RAISE EXCEPTION '108: há festa de hoje em diante em salão inativo; corrija com autorização antes; nada alterado';
  END IF;
END $$;
