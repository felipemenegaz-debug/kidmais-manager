-- Rollback da 100: volta o corpo da 094 de kidmais094_conflito_ocupacao (capacidade gravada no ramo POR_HORARIO).
-- Recusado se o corpo atual não for exatamente o da 100 (nada alterado). Não mexe em dados.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;
DO $$
BEGIN
  IF (SELECT encode(sha256(convert_to(replace(prosrc, E'\r', ''), 'UTF8')), 'hex') FROM pg_proc WHERE oid = to_regprocedure('public.kidmais094_conflito_ocupacao(uuid,date,time without time zone,time without time zone,uuid,uuid,uuid,uuid)')) IS DISTINCT FROM '805cd427a7cc7a725fb3bdfb4fd050f04e618131104fcfc0678a0ddadd5b4bdb' THEN
    RAISE EXCEPTION '100 rollback: corpo atual não é o da 100; nada alterado';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.kidmais094_conflito_ocupacao(fid uuid, dia date, ini time, fim time, emp uuid, uni uuid, cfg uuid, salao uuid)
RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path = public, pg_catalog AS $$
DECLARE
  c agenda_escopo_config%ROWTYPE;
  ini_m integer := (extract(epoch FROM ini) / 60)::integer;
  fim_m integer := (extract(epoch FROM fim) / 60)::integer;
  intervalo integer;
  capacidade_horario integer;
BEGIN
  IF emp IS NOT NULL THEN
    SELECT * INTO c FROM agenda_escopo_config a
     WHERE a.empresa_id = emp AND a.estabelecimento_id IS NOT DISTINCT FROM uni;
  END IF;
  IF c.id IS NULL THEN
    RETURN EXISTS (SELECT 1 FROM kidmais094_ocupacoes(dia, dia) o
                    WHERE o.fechamento_id <> fid AND o.horario_inicio < fim AND o.horario_fim > ini
                      AND kidmais062_mesmo_recurso(emp, uni, o.empresa_id, o.estabelecimento_id));
  END IF;
  intervalo := c.intervalo_minimo_minutos;
  IF c.limite_festas_dia IS NOT NULL AND (
       SELECT count(DISTINCT o.fechamento_id) FROM kidmais094_ocupacoes(dia, dia) o
        WHERE o.fechamento_id <> fid AND kidmais062_mesmo_recurso(emp, uni, o.empresa_id, o.estabelecimento_id)
     ) >= c.limite_festas_dia THEN
    RETURN true;
  END IF;
  IF c.capacidade_tipo = 'POR_SALAO' THEN
    RETURN EXISTS (SELECT 1 FROM kidmais094_ocupacoes(dia, dia) o
                    WHERE o.fechamento_id <> fid AND kidmais062_mesmo_recurso(emp, uni, o.empresa_id, o.estabelecimento_id)
                      AND (o.salao_id IS NULL OR salao IS NULL OR o.salao_id = salao)
                      AND (extract(epoch FROM o.horario_inicio) / 60)::integer < fim_m + intervalo
                      AND (extract(epoch FROM o.horario_fim) / 60)::integer > ini_m - intervalo);
  END IF;
  IF EXISTS (SELECT 1 FROM kidmais094_ocupacoes(dia, dia) o
              WHERE o.fechamento_id <> fid AND kidmais062_mesmo_recurso(emp, uni, o.empresa_id, o.estabelecimento_id)
                AND o.configuracao_agenda_id IS DISTINCT FROM cfg AND o.horario_inicio < fim AND o.horario_fim > ini) THEN
    RETURN true;
  END IF;
  SELECT ca.capacidade INTO capacidade_horario FROM configuracao_agenda ca WHERE ca.id = cfg;
  -- Fechamentos distintos: a remarcação em hold ocupa a origem e o destino, mas é UMA festa (parecer do Astra, P2).
  RETURN (SELECT count(DISTINCT o.fechamento_id) FROM kidmais094_ocupacoes(dia, dia) o
           WHERE o.fechamento_id <> fid AND kidmais062_mesmo_recurso(emp, uni, o.empresa_id, o.estabelecimento_id)
             AND o.configuracao_agenda_id = cfg
             AND (extract(epoch FROM o.horario_inicio) / 60)::integer < fim_m + intervalo
             AND (extract(epoch FROM o.horario_fim) / 60)::integer > ini_m - intervalo) >= coalesce(capacidade_horario, 1);
END $$;

DO $$
BEGIN
  IF (SELECT encode(sha256(convert_to(replace(prosrc, E'\r', ''), 'UTF8')), 'hex') FROM pg_proc WHERE oid = to_regprocedure('public.kidmais094_conflito_ocupacao(uuid,date,time without time zone,time without time zone,uuid,uuid,uuid,uuid)')) IS DISTINCT FROM 'b6aac1c0b99ed64f4dca94fe5d886e5d5892b82888325010e02adc850def8cf6' THEN
    RAISE EXCEPTION '100 rollback: postcheck falhou (corpo diferente do da 094)';
  END IF;
END $$;
COMMIT;
