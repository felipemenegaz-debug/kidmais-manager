-- Rollback da 108 (salões combinados rebaseados). Parecer do Astra (P1-1 da rev. 1): volta EXATAMENTE a base pós-106+107:
--   * kidmais094_conflito_ocupacao no corpo da 100 (POR_HORARIO >= 1; NÃO o da 094), hash 805cd427a7cc7a725fb3bdfb4fd050f04e618131104fcfc0678a0ddadd5b4bdb;
--   * kidmais019_validar_contrato e kidmais_validar_agenda_revisao nos corpos da 094;
--   * remove só os objetos da 108 (guardas, funções kidmais098_*, colunas combinado/membros, CHECK e o marcador);
--   * preserva 100/102/103/104/106/107 (nenhum objeto delas é tocado).
-- Recusa: 108 ausente ou parcial (corpos da 108 conferidos por hash), ou QUALQUER salão combinado (mesmo inativo e sem
-- referência), conferido sob trava contra escrita até o COMMIT. Antes do COMMIT confere os corpos restaurados e a ausência
-- de resto da 108.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;
-- Parecer do Astra de 29/10 (P1-2): trava contra QUALQUER escrita em agenda_saloes ANTES da leitura decisória ("nenhum
-- combinado") e até o COMMIT; um INSERT concorrente espera e, depois, encontra a coluna removida (ou o down recusa se ele
-- confirmou antes). SHARE ROW EXCLUSIVE conflita com INSERT/UPDATE/DELETE e deixa as leituras seguirem.
LOCK TABLE public.agenda_saloes IN SHARE ROW EXCLUSIVE MODE;
DO $$
BEGIN
  IF to_regprocedure('public.kidmais108_instalada()') IS NULL OR to_regprocedure('public.kidmais098_hoje()') IS NULL
    OR (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'agenda_saloes'
         AND column_name IN ('combinado', 'membros')) <> 2 THEN
    RAISE EXCEPTION '108 rollback: a 108 não está aplicada (ou está parcial); nada alterado';
  END IF;
  IF EXISTS (SELECT 1 FROM (VALUES
        ('kidmais094_conflito_ocupacao(uuid,date,time without time zone,time without time zone,uuid,uuid,uuid,uuid)', '06a387fe9c40ceca6a4021b1f9676b76ee92592a2cc241705f1201a40cc97537'),
        ('kidmais019_validar_contrato()', '13095fc87c52c3970f9cfad1c5bcef77d3e860904f71b39948de0335b4e76c21'),
        ('kidmais_validar_agenda_revisao()', '8476ec76d2ae8af4f7fbbdba595b0fd82b8060c76be4d2d915a47451f11f9e24')) AS e(f, h)
      WHERE (SELECT encode(sha256(convert_to(replace(prosrc, E'\r', ''), 'UTF8')), 'hex') FROM pg_proc WHERE oid = to_regprocedure('public.' || e.f))
            IS DISTINCT FROM e.h) THEN
    RAISE EXCEPTION '108 rollback: corpos da 108 divergentes (instalação parcial ou alterada); nada alterado';
  END IF;
  IF EXISTS (SELECT 1 FROM agenda_saloes WHERE combinado OR membros IS NOT NULL) THEN
    RAISE EXCEPTION '108 rollback: existe salão combinado (mesmo inativo); nada alterado';
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

CREATE OR REPLACE FUNCTION public.kidmais019_validar_contrato() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
DECLARE cid uuid; vid uuid; contrato_estado text; fid uuid;
BEGIN
 IF TG_TABLE_NAME='contratos' THEN cid:=NEW.id;
 ELSIF TG_TABLE_NAME='fechamentos' THEN SELECT id INTO cid FROM contratos WHERE fechamento_id=NEW.id;
 ELSE cid:=NEW.contrato_id; END IF;
 SELECT c.status,c.fechamento_id,cf.versao_vigente_id INTO contrato_estado,fid,vid FROM contratos c
 LEFT JOIN contrato_fluxos cf ON cf.contrato_id=c.id WHERE c.id=cid;
 IF contrato_estado='CANCELADO' THEN
  IF EXISTS(SELECT 1 FROM fechamento_revisoes WHERE contrato_id=cid AND estado IN ('EM_ELABORACAO','CONGELADA'))
  THEN RAISE EXCEPTION 'Cancelamento exige encerrar a preparação' USING ERRCODE='23514'; END IF;
  RETURN NULL;
 END IF;
 IF contrato_estado='ASSINADO' THEN
  IF NOT kidmais019_formalizacao(cid,vid) OR NOT EXISTS(SELECT 1 FROM festas WHERE contrato_id=cid AND invalidada_em IS NULL)
  THEN RAISE EXCEPTION 'Formalização exige duas assinaturas válidas e Festa ativa' USING ERRCODE='23514'; END IF;
 END IF;
 -- Check the actual occupied base, independently of a preparation's destination; only within the same resource.
 IF kidmais019_ocupa(fid) AND EXISTS(
  SELECT 1 FROM kidmais094_ocupacoes('-infinity'::date,'infinity'::date) a
  WHERE a.fechamento_id=fid
   AND kidmais094_conflito_ocupacao(fid,a.data,a.horario_inicio,a.horario_fim,a.empresa_id,a.estabelecimento_id,a.configuracao_agenda_id,a.salao_id))
 THEN RAISE EXCEPTION 'Conflito entre contratações' USING ERRCODE='23514'; END IF;
 IF kidmais019_ocupa(fid) AND EXISTS(
  SELECT 1 FROM kidmais062_ocupacoes_escopo('-infinity'::date,'infinity'::date) o JOIN bloqueios_agenda b ON b.data=o.data AND b.ativo
   AND kidmais062_bloqueio_aplica(b.empresa_id,b.estabelecimento_id,o.empresa_id,o.estabelecimento_id)
  WHERE o.fechamento_id=fid AND (b.dia_inteiro OR b.horario_inicio IS NULL OR b.horario_fim IS NULL OR (b.horario_inicio<o.horario_fim AND b.horario_fim>o.horario_inicio)))
 THEN RAISE EXCEPTION 'Contratação conflita com bloqueio' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.kidmais_validar_agenda_revisao() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r public.fechamento_revisoes%ROWTYPE; f public.fechamentos%ROWTYPE; target_day date; ini time; fim time; fid uuid;
BEGIN
 IF TG_TABLE_NAME='fechamentos' THEN
  SELECT * INTO f FROM public.fechamentos WHERE id=NEW.id;
  IF NOT public.kidmais019_ocupa(f.id) OR public.kidmais061_historico_passado(f.id) THEN RETURN NULL; END IF;
  target_day:=f.data_evento; ini:=f.horario_inicio; fim:=f.horario_fim; fid:=f.id;
 ELSE
  SELECT * INTO r FROM public.fechamento_revisoes WHERE id=NEW.id;
  SELECT * INTO f FROM public.fechamentos WHERE id=r.fechamento_id;
  IF r.estado='CANCELADA' THEN RETURN NULL; END IF;
  IF r.hold_destino_adquirido_em IS NOT NULL AND NOT public.kidmais019_ocupa(f.id) THEN RAISE EXCEPTION 'Hold exige reserva vigente confirmada' USING ERRCODE='23514'; END IF;
  -- A deferred event may observe the already-applied terminal row.
  IF r.hold_destino_adquirido_em IS NULL AND r.estado<>'APLICADA' THEN RETURN NULL; END IF;
  IF r.estado='APLICADA' AND public.kidmais019_ocupa(f.id) AND r.hold_destino_adquirido_em IS NULL THEN RAISE EXCEPTION 'Remarcação confirmada exige hold validado' USING ERRCODE='23514'; END IF;
  target_day:=r.data_evento; ini:=r.horario_inicio; fim:=r.horario_fim; fid:=r.fechamento_id;
 END IF;
 PERFORM public.kidmais_lock_datas_revisao(ARRAY[target_day]);
 IF public.kidmais094_conflito_ocupacao(fid,target_day,ini,fim,f.empresa_id,f.estabelecimento_id,
   CASE WHEN TG_TABLE_NAME='fechamentos' THEN f.configuracao_agenda_id ELSE r.configuracao_agenda_id END,
   CASE WHEN TG_TABLE_NAME='fechamentos' THEN f.salao_id ELSE COALESCE(r.salao_id,f.salao_id) END)
 OR EXISTS(SELECT 1 FROM public.bloqueios_agenda b WHERE b.ativo AND b.data=target_day AND public.kidmais062_bloqueio_aplica(b.empresa_id,b.estabelecimento_id,f.empresa_id,f.estabelecimento_id)
   AND (b.dia_inteiro OR b.horario_inicio IS NULL OR b.horario_fim IS NULL OR (b.horario_inicio<fim AND b.horario_fim>ini))) THEN RAISE EXCEPTION 'Conflito de agenda da revisão' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;

DROP TRIGGER contratos_098_truncate_trg ON public.contratos;
DROP TRIGGER contratos_098_guarda_trg ON public.contratos;
DROP TRIGGER agenda_saloes_098_truncate_trg ON public.agenda_saloes;
DROP TRIGGER agenda_saloes_098_combinado_diferido ON public.agenda_saloes;
DROP TRIGGER agenda_saloes_098_combinado_trg ON public.agenda_saloes;
DROP TRIGGER agenda_saloes_098_guarda_trg ON public.agenda_saloes;
DROP FUNCTION public.kidmais098_contrato_guarda();
DROP FUNCTION public.kidmais098_proibir_truncate();
DROP FUNCTION public.kidmais098_combinado_validar();
DROP FUNCTION public.kidmais098_salao_guarda();
DROP FUNCTION public.kidmais098_validar_elegibilidade(uuid);
DROP FUNCTION public.kidmais098_salao_elegivel(uuid);
DROP FUNCTION public.kidmais098_saloes_cruzam(uuid, uuid);
DROP FUNCTION public.kidmais098_conjunto(uuid);
ALTER TABLE public.agenda_saloes DROP CONSTRAINT agenda_saloes_098_membros_check;
ALTER TABLE public.agenda_saloes DROP COLUMN membros, DROP COLUMN combinado;
DROP FUNCTION public.kidmais098_membros_canonicos(uuid[]);
DROP FUNCTION public.kidmais098_hoje();
DROP FUNCTION public.kidmais108_instalada();

-- Verificação final: corpos da 100/094 de volta e nenhum resto da 108.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM (VALUES
        ('kidmais094_conflito_ocupacao(uuid,date,time without time zone,time without time zone,uuid,uuid,uuid,uuid)', '805cd427a7cc7a725fb3bdfb4fd050f04e618131104fcfc0678a0ddadd5b4bdb'),
        ('kidmais019_validar_contrato()', '4d462947bc173967fe9ff059a4aa857bd068502c042ae81a97c918e3362bf43e'),
        ('kidmais_validar_agenda_revisao()', '951825ad597495b477963ebb74df0120c1e8f4c59d39f6b7b32f53e5baaea821')) AS e(f, h)
      WHERE (SELECT encode(sha256(convert_to(replace(prosrc, E'\r', ''), 'UTF8')), 'hex') FROM pg_proc WHERE oid = to_regprocedure('public.' || e.f))
            IS DISTINCT FROM e.h)
    OR EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND (proname LIKE 'kidmais098\_%' OR proname = 'kidmais108_instalada'))
    OR EXISTS (SELECT 1 FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE '%\_098\_%')
    OR EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'agenda_saloes' AND column_name IN ('combinado', 'membros')) THEN
    RAISE EXCEPTION '108 rollback: verificação final falhou (corpos da 100/094 ou resto da 108); nada alterado';
  END IF;
END $$;
COMMIT;
