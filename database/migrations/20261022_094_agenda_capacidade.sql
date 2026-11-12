-- 094: capacidade, limite de festas por dia e intervalo mínimo na regra de conflito da agenda (etapa 2b das decisões
-- de Felipe em 22/10/2026), sobre a configuração por unidade da 093.
-- Regra (kidmais094_conflito_ocupacao), só entre festas que ocupam a agenda, no mesmo recurso (062) e no mesmo dia:
--   * unidade sem configuração (093 vazia): a regra de antes, qualquer sobreposição é conflito;
--   * limite do dia: conflito quando as festas que ocupam o dia no escopo já chegaram ao limite;
--   * por salão: conflito só no mesmo salão, contando o intervalo mínimo nas duas pontas (festa sem salão conflita com
--     qualquer sobreposição: regra conservadora);
--   * por horário: no mesmo horário, conflito quando as festas sobrepostas (com o intervalo) chegam à capacidade dele;
--     horários diferentes que se sobrepõem continuam em conflito (decisão de Felipe);
--   * bloqueio: como antes, fecha o horário inteiro (decisão de Felipe).
-- O salão da festa (fechamentos.salao_id) é escolhido pelo sistema na confirmação/formalização (primeiro livre que o
-- horário e o pacote permitem; decisão de Felipe) e a remarcação herda o salão.
-- Os corpos de kidmais019_validar_destino, kidmais019_validar_contrato e kidmais_validar_agenda_revisao são os da 062
-- com a cláusula de sobreposição trocada pela função acima (gerados por script); o manifesto da Festa
-- (lib/festas/estrutura-019.ts) ganha o conjunto 094. ORDEM: código com o conjunto 094 no manifesto ANTES da 094 (o
-- módulo Festa aceita 062 e 094); depois a 094.
-- Executar somente após autorização própria do ambiente, precheck e backup operacional.
-- Rollback: database/rollback/20261022_094_agenda_capacidade_down.sql (volta os corpos da 062; recusado com salão gravado).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;
DO $$
BEGIN
  IF to_regclass('public.agenda_escopo_config') IS NULL OR to_regclass('public.agenda_saloes') IS NULL
    OR to_regprocedure('public.kidmais062_ocupacoes_escopo(date,date)') IS NULL
    OR to_regprocedure('public.kidmais019_validar_destino(uuid)') IS NULL
    OR to_regprocedure('public.kidmais094_conflito_ocupacao(uuid,date,time without time zone,time without time zone,uuid,uuid,uuid,uuid)') IS NOT NULL
    OR EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('fechamentos', 'fechamento_revisoes') AND column_name = 'salao_id') THEN
    RAISE EXCEPTION '094: precheck falhou (062/093 ausentes ou 094 anterior/parcial); nada alterado';
  END IF;
END $$;

ALTER TABLE public.fechamentos ADD COLUMN salao_id uuid REFERENCES public.agenda_saloes(id) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- O salão é da mesma empresa e do mesmo escopo (unidade, ou a empresa sem unidade) da festa.
CREATE FUNCTION public.kidmais094_salao_fechamento() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
BEGIN
  IF NEW.salao_id IS NULL THEN RETURN NEW; END IF;
  IF NOT EXISTS (SELECT 1 FROM agenda_saloes s WHERE s.id = NEW.salao_id AND s.empresa_id = NEW.empresa_id
                  AND s.estabelecimento_id IS NOT DISTINCT FROM NEW.estabelecimento_id) THEN
    RAISE EXCEPTION '094: salão de outra empresa ou unidade' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fechamentos_094_salao_trg BEFORE INSERT OR UPDATE OF salao_id ON public.fechamentos
  FOR EACH ROW EXECUTE FUNCTION public.kidmais094_salao_fechamento();

-- Remarcação (parecer do Astra, P1): o destino tem o próprio salão, validado contra horário × pacote × salão ativo no
-- hold e copiado para a festa quando a revisão é aplicada. Mesma empresa e unidade da festa.
ALTER TABLE public.fechamento_revisoes ADD COLUMN salao_id uuid REFERENCES public.agenda_saloes(id) ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE FUNCTION public.kidmais094_salao_revisao() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
BEGIN
  IF NEW.salao_id IS NULL THEN RETURN NEW; END IF;
  IF NOT EXISTS (SELECT 1 FROM agenda_saloes s JOIN fechamentos f ON f.id = NEW.fechamento_id
                  WHERE s.id = NEW.salao_id AND s.empresa_id = f.empresa_id
                    AND s.estabelecimento_id IS NOT DISTINCT FROM f.estabelecimento_id) THEN
    RAISE EXCEPTION '094: salão de outra empresa ou unidade' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fechamento_revisoes_094_salao_trg BEFORE INSERT OR UPDATE OF salao_id ON public.fechamento_revisoes
  FOR EACH ROW EXECUTE FUNCTION public.kidmais094_salao_revisao();

-- Ocupações com escopo da 062, mais o horário (a revisão usa o do destino) e o salão da festa.
CREATE FUNCTION public.kidmais094_ocupacoes(inicio date, fim date)
RETURNS TABLE(fechamento_id uuid, revisao_id uuid, origem text, data date, horario_inicio time, horario_fim time,
              empresa_id uuid, estabelecimento_id uuid, configuracao_agenda_id uuid, salao_id uuid)
LANGUAGE sql STABLE SET search_path = public, pg_catalog AS $$
 SELECT f.id,NULL::uuid,'CONFIRMADA'::text,f.data_evento,f.horario_inicio,f.horario_fim,f.empresa_id,f.estabelecimento_id,f.configuracao_agenda_id,f.salao_id
 FROM fechamentos f WHERE kidmais019_ocupa(f.id) AND NOT kidmais061_historico_passado(f.id) AND f.data_evento BETWEEN inicio AND fim
 UNION ALL SELECT r.fechamento_id,r.id,'REVISAO_DESTINO'::text,r.data_evento,r.horario_inicio,r.horario_fim,f.empresa_id,f.estabelecimento_id,r.configuracao_agenda_id,COALESCE(r.salao_id,f.salao_id)
 FROM fechamento_revisoes r JOIN fechamentos f ON f.id=r.fechamento_id JOIN contrato_fluxos cf ON cf.contrato_id=r.contrato_id
 WHERE kidmais019_ocupa(r.fechamento_id) AND r.estado IN ('EM_ELABORACAO','CONGELADA')
 AND r.hold_destino_adquirido_em IS NOT NULL AND cf.versao_em_preparacao_id=r.contrato_versao_id
 AND cf.versao_vigente_id=r.versao_base_id AND r.data_evento BETWEEN inicio AND fim;
$$;

-- Verdadeiro quando a ocupação (fid no dia/intervalo, no escopo, horário e salão dados) conflita com outra.
CREATE FUNCTION public.kidmais094_conflito_ocupacao(fid uuid, dia date, ini time, fim time, emp uuid, uni uuid, cfg uuid, salao uuid)
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

CREATE OR REPLACE FUNCTION public.kidmais019_validar_destino(cid uuid) RETURNS void
LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
DECLARE fid uuid; dia date; ini time; fim time; emp uuid; uni uuid; cfg uuid; sal uuid; mesmo_slot boolean;
BEGIN
 SELECT f.id,COALESCE(r.data_evento,f.data_evento),COALESCE(r.horario_inicio,f.horario_inicio),COALESCE(r.horario_fim,f.horario_fim),f.empresa_id,f.estabelecimento_id,COALESCE(r.configuracao_agenda_id,f.configuracao_agenda_id),COALESCE(r.salao_id,f.salao_id),
  r.id IS NULL OR ROW(r.data_evento,r.horario_inicio,r.horario_fim) IS NOT DISTINCT FROM ROW(f.data_evento,f.horario_inicio,f.horario_fim)
 INTO fid,dia,ini,fim,emp,uni,cfg,sal,mesmo_slot FROM contratos c JOIN fechamentos f ON f.id=c.fechamento_id
 LEFT JOIN contrato_fluxos cf ON cf.contrato_id=c.id
 LEFT JOIN fechamento_revisoes r ON r.contrato_versao_id=cf.versao_em_preparacao_id AND r.estado IN ('EM_ELABORACAO','CONGELADA')
 WHERE c.id=cid AND c.status<>'CANCELADO';
 IF fid IS NULL THEN RAISE EXCEPTION 'Contratação ausente ou cancelada' USING ERRCODE='23514'; END IF;
 -- Unidade revogada: só a reserva que já ocupa, no mesmo horário, segue (formalização de proposta antiga e novo
 -- destino são novas ocupações na unidade).
 IF uni IS NOT NULL THEN
  PERFORM kidmais062_travar_habilitacao(uni);
  IF NOT kidmais062_unidade_agendavel(emp,uni) AND (NOT kidmais019_ocupa(fid) OR NOT mesmo_slot) THEN
   RAISE EXCEPTION '062: unidade sem habilitação vigente; nova reserva ou novo horário exige unidade habilitada' USING ERRCODE='23514'; END IF;
 END IF;
 IF kidmais094_conflito_ocupacao(fid,dia,ini,fim,emp,uni,cfg,sal)
 OR EXISTS(SELECT 1 FROM bloqueios_agenda b WHERE b.ativo AND b.data=dia AND kidmais062_bloqueio_aplica(b.empresa_id,b.estabelecimento_id,emp,uni) AND
 (b.dia_inteiro OR b.horario_inicio IS NULL OR b.horario_fim IS NULL OR (b.horario_inicio<fim AND b.horario_fim>ini)))
 THEN RAISE EXCEPTION 'Horário indisponível: formalização não concluída' USING ERRCODE='23514'; END IF;
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

COMMIT;
