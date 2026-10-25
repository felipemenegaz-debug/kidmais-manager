-- 100: uma festa por vez no horário da agenda com um salão (POR_HORARIO), qualquer que seja a capacidade gravada.
-- Decisão de Felipe (25/10/2026): nunca duas festas no mesmo horário, a não ser com salões distintos e o nome do salão no
-- contrato, no resumo do cliente e no convite. A tela e o servidor já não gravam capacidade diferente de 1, mas a regra
-- central da 094 (kidmais094_conflito_ocupacao) ainda lia configuracao_agenda.capacidade: uma linha antiga com 2
-- permitiria a segunda confirmação, inclusive pela integração de contrato (kidmais019_validar_destino). Parecer do Astra
-- de 25/10/2026 (P1): corrigir a regra central, sem editar a 094 aplicada e sem reescrever dados ou festas.
--   * só muda o último passo do ramo POR_HORARIO (`>= coalesce(capacidade, 1)` passa a `>= 1`); POR_SALAO, limite do
--     dia, intervalo, horários diferentes sobrepostos e empresa sem configuração ficam como na 094;
--   * a coluna configuracao_agenda.capacidade continua existindo (o ramo POR_SALAO não a usa; o código grava 1);
--   * exige o corpo EXATO da 094 (sha b6aac1c0b99e…). Com a 098 aplicada o corpo é outro e a 100 recusa:
--     a 098 está pausada e, ao ser retomada, precisa trazer esta mesma regra e o hash novo na precheck dela;
--   * a 098 sem a 100 também recusa depois desta (a precheck dela exige o corpo da 094): nada passa por cima em silêncio.
-- Executar somente após autorização própria do ambiente, precheck, backup operacional e integridade.
-- Rollback: database/rollback/20261025_100_agenda_um_salao_down.sql (volta o corpo da 094; recusado com corpo diferente do da 100).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;
DO $$
BEGIN
  IF to_regclass('public.agenda_escopo_config') IS NULL OR to_regprocedure('public.kidmais094_ocupacoes(date,date)') IS NULL
    OR to_regprocedure('public.kidmais094_conflito_ocupacao(uuid,date,time without time zone,time without time zone,uuid,uuid,uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION '100: precheck falhou (093/094 ausentes); nada alterado';
  END IF;
  IF (SELECT encode(sha256(convert_to(replace(prosrc, E'\r', ''), 'UTF8')), 'hex') FROM pg_proc WHERE oid = to_regprocedure('public.kidmais094_conflito_ocupacao(uuid,date,time without time zone,time without time zone,uuid,uuid,uuid,uuid)')) IS DISTINCT FROM 'b6aac1c0b99ed64f4dca94fe5d886e5d5892b82888325010e02adc850def8cf6' THEN
    RAISE EXCEPTION '100: precheck falhou (corpo da regra de conflito diferente do da 094: 100 já aplicada ou 098 presente); nada alterado';
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
  -- 100: com um salão, uma festa por vez no horário, qualquer que seja a capacidade gravada (decisão de Felipe, 25/10/2026).
  -- Fechamentos distintos: a remarcação em hold ocupa a origem e o destino, mas é UMA festa (parecer do Astra, P2).
  RETURN (SELECT count(DISTINCT o.fechamento_id) FROM kidmais094_ocupacoes(dia, dia) o
           WHERE o.fechamento_id <> fid AND kidmais062_mesmo_recurso(emp, uni, o.empresa_id, o.estabelecimento_id)
             AND o.configuracao_agenda_id = cfg
             AND (extract(epoch FROM o.horario_inicio) / 60)::integer < fim_m + intervalo
             AND (extract(epoch FROM o.horario_fim) / 60)::integer > ini_m - intervalo) >= 1;
END $$;

DO $$
BEGIN
  IF (SELECT encode(sha256(convert_to(replace(prosrc, E'\r', ''), 'UTF8')), 'hex') FROM pg_proc WHERE oid = to_regprocedure('public.kidmais094_conflito_ocupacao(uuid,date,time without time zone,time without time zone,uuid,uuid,uuid,uuid)')) IS DISTINCT FROM '805cd427a7cc7a725fb3bdfb4fd050f04e618131104fcfc0678a0ddadd5b4bdb' THEN
    RAISE EXCEPTION '100: postcheck falhou (corpo gravado diferente do esperado)';
  END IF;
END $$;
COMMIT;
