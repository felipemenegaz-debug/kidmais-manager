-- Rollback da 094: volta os corpos da 062 das três funções de conflito e remove o salão da festa.
-- Recusado se alguma festa já tem salão (a remoção apagaria a escolha) ou se a 094 não está aplicada.
-- Depois do rollback, o manifesto da Festa volta a reconhecer o conjunto 062.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;
DO $$
BEGIN
  IF to_regprocedure('public.kidmais094_conflito_ocupacao(uuid,date,time without time zone,time without time zone,uuid,uuid,uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION '094 rollback: a 094 não está aplicada; nada alterado';
  END IF;
  IF EXISTS (SELECT 1 FROM fechamentos WHERE salao_id IS NOT NULL) OR EXISTS (SELECT 1 FROM fechamento_revisoes WHERE salao_id IS NOT NULL) THEN
    RAISE EXCEPTION '094 rollback: há festas com salão; nada alterado';
  END IF;
  -- A regra da 062 é exclusiva: festas (ou holds) sobrepostas no mesmo recurso, válidas pela capacidade da 094, ficariam
  -- em conflito permanente depois do rollback (parecer do Astra, P2).
  IF EXISTS (SELECT 1 FROM kidmais094_ocupacoes('-infinity'::date, 'infinity'::date) a
               JOIN kidmais094_ocupacoes('-infinity'::date, 'infinity'::date) b
                 ON b.data = a.data AND b.fechamento_id <> a.fechamento_id
                AND b.horario_inicio < a.horario_fim AND b.horario_fim > a.horario_inicio
                AND kidmais062_mesmo_recurso(a.empresa_id, a.estabelecimento_id, b.empresa_id, b.estabelecimento_id)) THEN
    RAISE EXCEPTION '094 rollback: há festas simultâneas no mesmo recurso (incompatíveis com a 062); nada alterado';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.kidmais019_validar_destino(cid uuid) RETURNS void
LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
DECLARE fid uuid; dia date; ini time; fim time; emp uuid; uni uuid; mesmo_slot boolean;
BEGIN
 SELECT f.id,COALESCE(r.data_evento,f.data_evento),COALESCE(r.horario_inicio,f.horario_inicio),COALESCE(r.horario_fim,f.horario_fim),f.empresa_id,f.estabelecimento_id,
  r.id IS NULL OR ROW(r.data_evento,r.horario_inicio,r.horario_fim) IS NOT DISTINCT FROM ROW(f.data_evento,f.horario_inicio,f.horario_fim)
 INTO fid,dia,ini,fim,emp,uni,mesmo_slot FROM contratos c JOIN fechamentos f ON f.id=c.fechamento_id
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
 IF EXISTS(SELECT 1 FROM kidmais062_ocupacoes_escopo(dia,dia) o WHERE o.fechamento_id<>fid AND o.horario_inicio<fim AND o.horario_fim>ini
   AND kidmais062_mesmo_recurso(emp,uni,o.empresa_id,o.estabelecimento_id))
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
  SELECT 1 FROM kidmais062_ocupacoes_escopo('-infinity'::date,'infinity'::date) a
  JOIN kidmais062_ocupacoes_escopo('-infinity'::date,'infinity'::date) b
   ON b.data=a.data AND b.fechamento_id<>a.fechamento_id AND b.horario_inicio<a.horario_fim AND b.horario_fim>a.horario_inicio
   AND kidmais062_mesmo_recurso(a.empresa_id,a.estabelecimento_id,b.empresa_id,b.estabelecimento_id)
  WHERE a.fechamento_id=fid)
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
 IF EXISTS(SELECT 1 FROM public.kidmais062_ocupacoes_escopo(target_day,target_day) o WHERE o.fechamento_id<>fid AND o.horario_inicio<fim AND o.horario_fim>ini
   AND public.kidmais062_mesmo_recurso(f.empresa_id,f.estabelecimento_id,o.empresa_id,o.estabelecimento_id))
 OR EXISTS(SELECT 1 FROM public.bloqueios_agenda b WHERE b.ativo AND b.data=target_day AND public.kidmais062_bloqueio_aplica(b.empresa_id,b.estabelecimento_id,f.empresa_id,f.estabelecimento_id)
   AND (b.dia_inteiro OR b.horario_inicio IS NULL OR b.horario_fim IS NULL OR (b.horario_inicio<fim AND b.horario_fim>ini))) THEN RAISE EXCEPTION 'Conflito de agenda da revisão' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;

DROP FUNCTION public.kidmais094_conflito_ocupacao(uuid, date, time, time, uuid, uuid, uuid, uuid);
DROP FUNCTION public.kidmais094_ocupacoes(date, date);
DROP TRIGGER fechamento_revisoes_094_salao_trg ON public.fechamento_revisoes;
DROP FUNCTION public.kidmais094_salao_revisao();
ALTER TABLE public.fechamento_revisoes DROP COLUMN salao_id;
DROP TRIGGER fechamentos_094_salao_trg ON public.fechamentos;
DROP FUNCTION public.kidmais094_salao_fechamento();
ALTER TABLE public.fechamentos DROP COLUMN salao_id;
COMMIT;
