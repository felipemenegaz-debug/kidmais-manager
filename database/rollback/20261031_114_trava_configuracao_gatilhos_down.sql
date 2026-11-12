-- Rollback da 114 (D-LIB-6): devolve os corpos da cadeia 108/109 e remove a verificação. Recusa se os corpos atuais
-- não forem exatamente os da 114.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;

DO $precheck$ BEGIN
 IF (SELECT encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex') FROM pg_proc WHERE oid='public.kidmais019_lock_ocupacao()'::regprocedure)
    IS DISTINCT FROM '2518c5bf7646946705955cd2875c09d432935d02f42a1d6f276e14f4b9c9dfd0'
 OR (SELECT encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex') FROM pg_proc WHERE oid='public.kidmais_validar_agenda_revisao()'::regprocedure)
    IS DISTINCT FROM 'dcbfd2b296635249273d36a2593baf15eefb27fa9628523357df4b56476638a1'
 THEN RAISE EXCEPTION '114 down: precheck falhou (corpos não são os da 114)'; END IF;
END $precheck$;

CREATE OR REPLACE FUNCTION public.kidmais019_lock_ocupacao() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
DECLARE cid uuid;
BEGIN
 IF TG_TABLE_NAME='fechamentos' THEN
  IF TG_OP='UPDATE' THEN PERFORM kidmais_lock_datas_revisao(ARRAY[OLD.data_evento,NEW.data_evento]);
  ELSE PERFORM kidmais_lock_datas_revisao(ARRAY[NEW.data_evento]); END IF;
  SELECT id INTO cid FROM contratos WHERE fechamento_id=NEW.id;
 ELSIF TG_TABLE_NAME='contratos' THEN cid:=NEW.id;
 ELSIF TG_TABLE_NAME='fechamento_revisoes' THEN
  cid:=NEW.contrato_id;
  IF TG_OP='UPDATE' THEN PERFORM kidmais_lock_datas_revisao(ARRAY[OLD.data_evento,NEW.data_evento]);
  ELSE PERFORM kidmais_lock_datas_revisao(ARRAY[NEW.data_evento]); END IF;
 ELSE cid:=NEW.contrato_id;
 END IF;
 IF cid IS NOT NULL THEN PERFORM kidmais019_bloquear_contrato(cid); END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.kidmais_validar_agenda_revisao() RETURNS trigger
LANGUAGE plpgsql AS $$
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
 PERFORM public.kidmais098_validar_elegibilidade(fid);
 IF public.kidmais094_conflito_ocupacao(fid,target_day,ini,fim,f.empresa_id,f.estabelecimento_id,
   CASE WHEN TG_TABLE_NAME='fechamentos' THEN f.configuracao_agenda_id ELSE r.configuracao_agenda_id END,
   CASE WHEN TG_TABLE_NAME='fechamentos' THEN f.salao_id ELSE COALESCE(r.salao_id,f.salao_id) END)
 OR EXISTS(SELECT 1 FROM public.bloqueios_agenda b WHERE b.ativo AND b.data=target_day AND public.kidmais062_bloqueio_aplica(b.empresa_id,b.estabelecimento_id,f.empresa_id,f.estabelecimento_id)
   AND (b.dia_inteiro OR b.horario_inicio IS NULL OR b.horario_fim IS NULL OR (b.horario_inicio<fim AND b.horario_fim>ini))) THEN RAISE EXCEPTION 'Conflito de agenda da revisão' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;

DROP FUNCTION public.kidmais114_exigir_configuracao(uuid);
COMMIT;
