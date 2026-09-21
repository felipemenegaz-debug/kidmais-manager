-- Production readiness: installation only. No reconciliation/backfill is performed.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = public, pg_catalog;

ALTER TABLE public.festas ADD COLUMN origem_criacao text NOT NULL DEFAULT 'MANUAL_HISTORICA';
-- PG18 exposes NOT NULL constraints in pg_constraint. Keep their old metadata so the
-- immutable 016 fingerprint can still be verified after this explicit nullable delta.
DO $$ DECLARE baseline jsonb; BEGIN
 SELECT COALESCE(jsonb_agg(jsonb_build_object('relname',t.relname,'conname',c.conname,'contype',c.contype,
 'convalidated',c.convalidated,'condeferrable',c.condeferrable,'condeferred',c.condeferred,
 'definicao',pg_get_constraintdef(c.oid))),'[]'::jsonb) INTO baseline
 FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=ANY(c.conkey)
 WHERE c.contype='n' AND c.connamespace='public'::regnamespace
 AND ((t.relname='festas' AND a.attname='criado_por') OR (t.relname='festa_eventos' AND a.attname='usuario_id'));
 EXECUTE format('COMMENT ON COLUMN public.festas.origem_criacao IS %L',baseline::text);
END $$;
ALTER TABLE public.festas ALTER COLUMN criado_por DROP NOT NULL;
ALTER TABLE public.festas ADD CONSTRAINT festa019_autoria_check CHECK (
 (origem_criacao='MANUAL_HISTORICA' AND criado_por IS NOT NULL) OR
 (origem_criacao='AUTOMATICA_FORMALIZACAO' AND criado_por IS NULL));
ALTER TABLE public.festa_eventos ADD COLUMN ator_tipo text NOT NULL DEFAULT 'USUARIO';
ALTER TABLE public.festa_eventos ALTER COLUMN usuario_id DROP NOT NULL;
ALTER TABLE public.festa_eventos ADD CONSTRAINT festa019_evento_autoria_check CHECK (
 (ator_tipo='USUARIO' AND usuario_id IS NOT NULL) OR
 (ator_tipo='SISTEMA' AND usuario_id IS NULL AND tipo='FESTA_CRIADA'
  AND COALESCE(identidade_snapshot->>'ator'='SISTEMA',false)));

CREATE FUNCTION public.kidmais019_formalizacao(cid uuid,vid uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = public, pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM contratos c JOIN contrato_fluxos cf ON cf.contrato_id=c.id
 JOIN contrato_versoes v ON v.id=cf.versao_vigente_id
 JOIN contrato_edicoes e ON e.contrato_versao_id=v.id
 JOIN contrato_documentos d ON d.id=e.documento_revisado_id
 JOIN contrato_assinaturas k ON k.contrato_versao_id=v.id AND k.parte='KIDMAIS'
 JOIN contrato_assinaturas a ON a.contrato_versao_id=v.id AND a.parte='CLIENTE'
 WHERE c.id=cid AND v.id=vid AND c.status='ASSINADO' AND c.cancelado_em IS NULL
 AND v.status='ASSINADA' AND e.estado='CONCLUIDA'
 AND k.documento_id=d.id AND a.documento_id=d.id AND d.contrato_versao_id=v.id
 AND k.snapshot_hash=v.snapshot_hash AND a.snapshot_hash=v.snapshot_hash AND d.snapshot_hash=v.snapshot_hash
 AND k.pdf_hash=d.pdf_hash AND a.pdf_hash=d.pdf_hash AND v.documento_pdf_hash=d.pdf_hash);
$$;

CREATE FUNCTION public.kidmais019_ocupa(fid uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = public, pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM fechamentos f WHERE f.id=fid AND f.status<>'CANCELADO'
 AND NOT EXISTS(SELECT 1 FROM contratos c WHERE c.fechamento_id=f.id AND c.status='CANCELADO')
 AND (f.status='CONFIRMADO' OR EXISTS(SELECT 1 FROM contratos c JOIN contrato_fluxos cf ON cf.contrato_id=c.id
 WHERE c.fechamento_id=f.id AND kidmais019_formalizacao(c.id,cf.versao_vigente_id))));
$$;

CREATE OR REPLACE FUNCTION public.kidmais_ocupacoes_operacionais(inicio date,fim date)
RETURNS TABLE(fechamento_id uuid,revisao_id uuid,origem text,data date,horario_inicio time,horario_fim time)
LANGUAGE sql STABLE AS $$
 SELECT f.id,NULL::uuid,'CONFIRMADA'::text,f.data_evento,f.horario_inicio,f.horario_fim
 FROM public.fechamentos f WHERE public.kidmais019_ocupa(f.id) AND f.data_evento BETWEEN inicio AND fim
 UNION ALL SELECT r.fechamento_id,r.id,'REVISAO_DESTINO'::text,r.data_evento,r.horario_inicio,r.horario_fim
 FROM public.fechamento_revisoes r JOIN public.contrato_fluxos cf ON cf.contrato_id=r.contrato_id
 WHERE public.kidmais019_ocupa(r.fechamento_id) AND r.estado IN ('EM_ELABORACAO','CONGELADA')
 AND r.hold_destino_adquirido_em IS NOT NULL AND cf.versao_em_preparacao_id=r.contrato_versao_id
 AND cf.versao_vigente_id=r.versao_base_id AND r.data_evento BETWEEN inicio AND fim;
$$;

CREATE FUNCTION public.kidmais019_bloquear_contrato(cid uuid) RETURNS void
LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
DECLARE dias date[];
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION '019 exige transação READ COMMITTED' USING ERRCODE='25000'; END IF;
 SELECT array_agg(DISTINCT dia ORDER BY dia) INTO dias FROM (
 SELECT f.data_evento dia FROM fechamentos f JOIN contratos c ON c.fechamento_id=f.id WHERE c.id=cid
 UNION SELECT r.data_evento FROM fechamento_revisoes r WHERE r.contrato_id=cid AND r.estado IN ('EM_ELABORACAO','CONGELADA')) x;
 PERFORM kidmais_lock_datas_revisao(dias);
END $$;

CREATE FUNCTION public.kidmais019_validar_destino(cid uuid) RETURNS void
LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
DECLARE fid uuid; dia date; ini time; fim time;
BEGIN
 SELECT f.id,COALESCE(r.data_evento,f.data_evento),COALESCE(r.horario_inicio,f.horario_inicio),COALESCE(r.horario_fim,f.horario_fim)
 INTO fid,dia,ini,fim FROM contratos c JOIN fechamentos f ON f.id=c.fechamento_id
 LEFT JOIN contrato_fluxos cf ON cf.contrato_id=c.id
 LEFT JOIN fechamento_revisoes r ON r.contrato_versao_id=cf.versao_em_preparacao_id AND r.estado IN ('EM_ELABORACAO','CONGELADA')
 WHERE c.id=cid AND c.status<>'CANCELADO';
 IF fid IS NULL THEN RAISE EXCEPTION 'Contratação ausente ou cancelada' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM kidmais_ocupacoes_operacionais(dia,dia) o WHERE o.fechamento_id<>fid AND o.horario_inicio<fim AND o.horario_fim>ini)
 OR EXISTS(SELECT 1 FROM bloqueios_agenda b WHERE b.ativo AND b.data=dia AND
 (b.dia_inteiro OR b.horario_inicio IS NULL OR b.horario_fim IS NULL OR (b.horario_inicio<fim AND b.horario_fim>ini)))
 THEN RAISE EXCEPTION 'Horário indisponível: formalização não concluída' USING ERRCODE='23514'; END IF;
END $$;

-- Lock before publishing any change to occupancy. All dates use the existing lock namespace.
CREATE FUNCTION public.kidmais019_lock_ocupacao() RETURNS trigger
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
CREATE TRIGGER festa019_lock_fechamento BEFORE INSERT OR UPDATE ON public.fechamentos FOR EACH ROW EXECUTE FUNCTION public.kidmais019_lock_ocupacao();
CREATE TRIGGER festa019_lock_contrato BEFORE INSERT OR UPDATE ON public.contratos FOR EACH ROW EXECUTE FUNCTION public.kidmais019_lock_ocupacao();
CREATE TRIGGER festa019_lock_fluxo BEFORE INSERT OR UPDATE ON public.contrato_fluxos FOR EACH ROW EXECUTE FUNCTION public.kidmais019_lock_ocupacao();
CREATE TRIGGER festa019_lock_revisao BEFORE INSERT OR UPDATE ON public.fechamento_revisoes FOR EACH ROW EXECUTE FUNCTION public.kidmais019_lock_ocupacao();

CREATE FUNCTION public.kidmais019_validar_contrato() RETURNS trigger
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
 -- Check the actual occupied base, independently of a preparation's destination.
 IF kidmais019_ocupa(fid) AND EXISTS(
  SELECT 1 FROM kidmais_ocupacoes_operacionais('-infinity'::date,'infinity'::date) a
  JOIN kidmais_ocupacoes_operacionais('-infinity'::date,'infinity'::date) b
   ON b.data=a.data AND b.fechamento_id<>a.fechamento_id AND b.horario_inicio<a.horario_fim AND b.horario_fim>a.horario_inicio
  WHERE a.fechamento_id=fid)
 THEN RAISE EXCEPTION 'Conflito entre contratações' USING ERRCODE='23514'; END IF;
 IF kidmais019_ocupa(fid) AND EXISTS(
  SELECT 1 FROM kidmais_ocupacoes_operacionais('-infinity'::date,'infinity'::date) o JOIN bloqueios_agenda b ON b.data=o.data AND b.ativo
  WHERE o.fechamento_id=fid AND (b.dia_inteiro OR b.horario_inicio IS NULL OR b.horario_fim IS NULL OR (b.horario_inicio<o.horario_fim AND b.horario_fim>o.horario_inicio)))
 THEN RAISE EXCEPTION 'Contratação conflita com bloqueio' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER festa019_contrato AFTER INSERT OR UPDATE ON public.contratos DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.kidmais019_validar_contrato();
CREATE CONSTRAINT TRIGGER festa019_fluxo AFTER INSERT OR UPDATE ON public.contrato_fluxos DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.kidmais019_validar_contrato();
CREATE CONSTRAINT TRIGGER festa019_fechamento AFTER INSERT OR UPDATE ON public.fechamentos DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.kidmais019_validar_contrato();
CREATE CONSTRAINT TRIGGER festa019_festa AFTER INSERT OR UPDATE ON public.festas DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.kidmais019_validar_contrato();

CREATE FUNCTION public.kidmais019_proteger_invalidacao() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
BEGIN
 IF TG_OP='INSERT' AND NOT kidmais019_formalizacao(NEW.contrato_id,NEW.versao_contratual_criacao_id)
 THEN RAISE EXCEPTION 'Criação exige contratação formalizada vigente' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' AND ROW(NEW.contrato_id,NEW.versao_contratual_criacao_id,NEW.origem_criacao,NEW.criado_por,NEW.chave_criacao,NEW.payload_hash)
 IS DISTINCT FROM ROW(OLD.contrato_id,OLD.versao_contratual_criacao_id,OLD.origem_criacao,OLD.criado_por,OLD.chave_criacao,OLD.payload_hash)
 THEN RAISE EXCEPTION 'Identidade e autoria de criação da Festa são imutáveis' USING ERRCODE='23514'; END IF;
 IF NEW.invalidada_em IS NOT NULL AND EXISTS(SELECT 1 FROM contratos WHERE id=NEW.contrato_id AND status='ASSINADO')
 THEN RAISE EXCEPTION 'Use cancelamento contratual; invalidação não libera contratação assinada' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER festa019_invalidacao BEFORE INSERT OR UPDATE ON public.festas FOR EACH ROW EXECUTE FUNCTION public.kidmais019_proteger_invalidacao();

CREATE OR REPLACE FUNCTION public.kidmais_proteger_bloqueio_revisao() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' THEN PERFORM public.kidmais_lock_datas_revisao(ARRAY[OLD.data,NEW.data]); ELSE PERFORM public.kidmais_lock_datas_revisao(ARRAY[NEW.data]); END IF;
 IF NOT NEW.ativo THEN RETURN NEW; END IF;
 IF EXISTS(SELECT 1 FROM public.kidmais_ocupacoes_operacionais(NEW.data,NEW.data) o WHERE
 (NEW.dia_inteiro OR NEW.horario_inicio IS NULL OR NEW.horario_fim IS NULL OR (o.horario_inicio<NEW.horario_fim AND o.horario_fim>NEW.horario_inicio)))
 THEN RAISE EXCEPTION 'Bloqueio conflita com contratação vigente' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;

-- The revision validator is replaced below with the same rules, using contractual occupancy.
CREATE OR REPLACE FUNCTION public.kidmais_validar_agenda_revisao() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r public.fechamento_revisoes%ROWTYPE; f public.fechamentos%ROWTYPE; target_day date; ini time; fim time; fid uuid;
BEGIN
 IF TG_TABLE_NAME='fechamentos' THEN
  SELECT * INTO f FROM public.fechamentos WHERE id=NEW.id;
  IF NOT public.kidmais019_ocupa(f.id) THEN RETURN NULL; END IF;
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
 IF EXISTS(SELECT 1 FROM public.kidmais_ocupacoes_operacionais(target_day,target_day) o WHERE o.fechamento_id<>fid AND o.horario_inicio<fim AND o.horario_fim>ini) OR EXISTS(SELECT 1 FROM public.bloqueios_agenda b WHERE b.ativo AND b.data=target_day AND (b.dia_inteiro OR b.horario_inicio IS NULL OR b.horario_fim IS NULL OR (b.horario_inicio<fim AND b.horario_fim>ini))) THEN RAISE EXCEPTION 'Conflito de agenda da revisão' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
-- Installation must not silently activate overlapping pre-existing commitments.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.contratos c LEFT JOIN public.contrato_fluxos cf ON cf.contrato_id=c.id
 WHERE c.status='ASSINADO' AND NOT public.kidmais019_formalizacao(c.id,cf.versao_vigente_id))
 THEN RAISE EXCEPTION '019: contrato assinado legado/inconsistente exige revisão'; END IF;
 IF EXISTS(SELECT 1 FROM public.kidmais_ocupacoes_operacionais('-infinity'::date,'infinity'::date) a
 JOIN public.kidmais_ocupacoes_operacionais('-infinity'::date,'infinity'::date) b
 ON a.fechamento_id<b.fechamento_id AND a.data=b.data AND a.horario_inicio<b.horario_fim AND a.horario_fim>b.horario_inicio)
 OR EXISTS(SELECT 1 FROM public.kidmais_ocupacoes_operacionais('-infinity'::date,'infinity'::date) o
 JOIN public.bloqueios_agenda b ON b.data=o.data AND b.ativo
 WHERE b.dia_inteiro OR b.horario_inicio IS NULL OR b.horario_fim IS NULL OR (b.horario_inicio<o.horario_fim AND b.horario_fim>o.horario_inicio))
 THEN RAISE EXCEPTION '019: conflito anterior; revisar individualmente antes da ativação'; END IF;
END $$;
COMMIT;
