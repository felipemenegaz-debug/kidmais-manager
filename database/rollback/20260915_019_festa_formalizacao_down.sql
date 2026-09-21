-- Only before any contractual/automatic use. Never remove signed history.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL search_path=public,pg_catalog;
LOCK TABLE public.contratos,public.fechamentos,public.contrato_fluxos,public.fechamento_revisoes,public.festas,public.festa_eventos,public.bloqueios_agenda IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.contratos WHERE status IN ('ASSINADO','CANCELADO')) OR EXISTS(SELECT 1 FROM public.festas WHERE origem_criacao='AUTOMATICA_FORMALIZACAO') OR EXISTS(SELECT 1 FROM public.festa_eventos WHERE ator_tipo='SISTEMA') THEN RAISE EXCEPTION 'Rollback 019 recusado: preservar contratos e autoria; correção forward necessária'; END IF;
END $$;
DROP TRIGGER festa019_lock_fechamento ON public.fechamentos;
DROP TRIGGER festa019_lock_contrato ON public.contratos;
DROP TRIGGER festa019_lock_fluxo ON public.contrato_fluxos;
DROP TRIGGER festa019_lock_revisao ON public.fechamento_revisoes;
DROP TRIGGER festa019_contrato ON public.contratos;
DROP TRIGGER festa019_fluxo ON public.contrato_fluxos;
DROP TRIGGER festa019_fechamento ON public.fechamentos;
DROP TRIGGER festa019_festa ON public.festas;
DROP TRIGGER festa019_invalidacao ON public.festas;
CREATE OR REPLACE FUNCTION kidmais_ocupacoes_operacionais(inicio date,fim date) RETURNS TABLE(fechamento_id uuid,revisao_id uuid,origem text,data date,horario_inicio time,horario_fim time) LANGUAGE sql STABLE AS $$
 SELECT f.id,NULL::uuid,'CONFIRMADA'::text,f.data_evento,f.horario_inicio,f.horario_fim FROM public.fechamentos f WHERE f.status='CONFIRMADO' AND f.data_evento BETWEEN inicio AND fim
 UNION ALL SELECT r.fechamento_id,r.id,'REVISAO_DESTINO'::text,r.data_evento,r.horario_inicio,r.horario_fim FROM public.fechamento_revisoes r JOIN public.fechamentos f ON f.id=r.fechamento_id JOIN public.contrato_fluxos cf ON cf.contrato_id=r.contrato_id
 WHERE f.status='CONFIRMADO' AND r.estado IN ('EM_ELABORACAO','CONGELADA') AND r.hold_destino_adquirido_em IS NOT NULL AND cf.versao_em_preparacao_id=r.contrato_versao_id AND cf.versao_vigente_id=r.versao_base_id AND r.data_evento BETWEEN inicio AND fim;
$$;
CREATE OR REPLACE FUNCTION kidmais_validar_agenda_revisao() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r public.fechamento_revisoes%ROWTYPE; f public.fechamentos%ROWTYPE; target_day date; ini time; fim time; fid uuid;
BEGIN
 IF TG_TABLE_NAME='fechamentos' THEN
  SELECT * INTO f FROM public.fechamentos WHERE id=NEW.id;
  IF f.status<>'CONFIRMADO' THEN RETURN NULL; END IF;
  IF TG_OP='UPDATE' THEN IF OLD.status='CONFIRMADO' AND ROW(OLD.data_evento,OLD.horario_inicio,OLD.horario_fim)=ROW(f.data_evento,f.horario_inicio,f.horario_fim) THEN RETURN NULL; END IF; END IF;
  target_day:=f.data_evento; ini:=f.horario_inicio; fim:=f.horario_fim; fid:=f.id;
 ELSE
  SELECT * INTO r FROM public.fechamento_revisoes WHERE id=NEW.id;
  SELECT * INTO f FROM public.fechamentos WHERE id=r.fechamento_id;
  IF r.estado='CANCELADA' THEN RETURN NULL; END IF;
  IF r.hold_destino_adquirido_em IS NOT NULL AND f.status<>'CONFIRMADO' THEN RAISE EXCEPTION 'Hold exige reserva vigente confirmada' USING ERRCODE='23514'; END IF;
  -- A deferred event may observe the already-applied terminal row.
  IF r.hold_destino_adquirido_em IS NULL AND r.estado<>'APLICADA' THEN RETURN NULL; END IF;
  IF r.estado='APLICADA' AND f.status='CONFIRMADO' AND r.hold_destino_adquirido_em IS NULL THEN RAISE EXCEPTION 'Remarcação confirmada exige hold validado' USING ERRCODE='23514'; END IF;
  target_day:=r.data_evento; ini:=r.horario_inicio; fim:=r.horario_fim; fid:=r.fechamento_id;
 END IF;
 PERFORM public.kidmais_lock_datas_revisao(ARRAY[target_day]);
 IF EXISTS(SELECT 1 FROM public.kidmais_ocupacoes_operacionais(target_day,target_day) o WHERE o.fechamento_id<>fid AND o.horario_inicio<fim AND o.horario_fim>ini) OR EXISTS(SELECT 1 FROM public.bloqueios_agenda b WHERE b.ativo AND b.data=target_day AND (b.dia_inteiro OR b.horario_inicio IS NULL OR b.horario_fim IS NULL OR (b.horario_inicio<fim AND b.horario_fim>ini))) THEN RAISE EXCEPTION 'Conflito de agenda da revisão' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION kidmais_proteger_bloqueio_revisao() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' THEN PERFORM public.kidmais_lock_datas_revisao(ARRAY[OLD.data,NEW.data]); ELSE PERFORM public.kidmais_lock_datas_revisao(ARRAY[NEW.data]); END IF;
 IF NOT NEW.ativo THEN RETURN NEW; END IF;
 IF EXISTS(SELECT 1 FROM public.kidmais_ocupacoes_operacionais(NEW.data,NEW.data) o WHERE EXISTS(SELECT 1 FROM public.fechamento_revisoes r WHERE r.fechamento_id=o.fechamento_id AND r.estado IN ('EM_ELABORACAO','CONGELADA')) AND (NEW.dia_inteiro OR NEW.horario_inicio IS NULL OR NEW.horario_fim IS NULL OR (o.horario_inicio<NEW.horario_fim AND o.horario_fim>NEW.horario_inicio))) THEN RAISE EXCEPTION 'Bloqueio conflita com reserva em revisão' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
DROP FUNCTION public.kidmais019_proteger_invalidacao();
DROP FUNCTION public.kidmais019_validar_contrato();
DROP FUNCTION public.kidmais019_lock_ocupacao();
DROP FUNCTION public.kidmais019_validar_destino(uuid);
DROP FUNCTION public.kidmais019_bloquear_contrato(uuid);
DROP FUNCTION public.kidmais019_ocupa(uuid);
DROP FUNCTION public.kidmais019_formalizacao(uuid,uuid);
ALTER TABLE public.festas DROP CONSTRAINT festa019_autoria_check, DROP COLUMN origem_criacao, ALTER COLUMN criado_por SET NOT NULL;
ALTER TABLE public.festa_eventos DROP CONSTRAINT festa019_evento_autoria_check, DROP COLUMN ator_tipo, ALTER COLUMN usuario_id SET NOT NULL;
COMMIT;
