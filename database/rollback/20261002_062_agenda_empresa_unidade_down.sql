-- Rollback 062 — devolve a agenda GLOBAL (019/061). NÃO APLICADO. Exige autorização explícita (docs/OPERACAO_AGENTES.md).
-- Gerado offline por scripts/migration-062-manifest.mjs: restaura byte a byte kidmais019_validar_destino (019), kidmais019_validar_contrato (019), kidmais_proteger_bloqueio_revisao (019), kidmais_validar_agenda_revisao (061),
-- remove gatilhos e funções kidmais062_* e confere os hashes no fim.
-- Global é sempre seguro (só conflita mais): nenhuma festa é liberada; pode aparecer conflito entre empresas que a 062
-- permitia (mesmo horário em unidades/empresas diferentes) — o rollback RECUSA se houver esse caso.
-- Estrutura:
--   * sem nenhum escopo gravado: removida por completo (volta ao schema da 061, inclusive o código de turno único);
--   * com escopo gravado (unidades, donos, resoluções): rollback SUAVE — colunas, tabela e dados preservados, só as
--     regras saem. A 062 pode ser reaplicada depois e reencontra a estrutura (database/migrations/...062...sql).
-- Recusa se houver turno ativo por empresa/unidade (sem a 062 ele entraria na agenda global de todas as empresas) ou
-- bloqueio com dono que alcançaria reserva de outro recurso (sem a 062 todo bloqueio volta a ser global).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = public, pg_catalog;
LOCK TABLE public.fechamentos, public.fechamento_revisoes, public.contrato_fluxos, public.bloqueios_agenda, public.configuracao_agenda, public.contrato_importacoes,
  public.agenda_062_unidades_habilitacao IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF to_regprocedure('public.kidmais062_ocupacoes_escopo(date,date)') IS NULL THEN RAISE EXCEPTION 'Rollback 062: não aplicada.'; END IF;
  IF EXISTS (SELECT 1 FROM public.configuracao_agenda WHERE ativo AND empresa_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Rollback 062 recusado: há turno ativo por empresa/unidade; desative-o por decisão explícita antes.';
  END IF;
  -- Com a agenda global, duas reservas simultâneas em recursos diferentes (de qualquer data) passariam a conflitar.
  IF EXISTS (SELECT 1 FROM public.kidmais062_ocupacoes_escopo('-infinity'::date, 'infinity'::date) a
               JOIN public.kidmais062_ocupacoes_escopo('-infinity'::date, 'infinity'::date) b
                 ON b.data = a.data AND b.fechamento_id <> a.fechamento_id
                AND b.horario_inicio < a.horario_fim AND b.horario_fim > a.horario_inicio) THEN
    RAISE EXCEPTION 'Rollback 062 recusado: há reservas simultâneas em recursos diferentes; a agenda global as tornaria conflitantes. Correção forward necessária.';
  END IF;
  -- Sem a 062, todo bloqueio ativo volta a valer para todas as empresas (o dono é ignorado): bloqueio de uma empresa ou
  -- unidade que alcança reserva de OUTRO recurso passaria a conflitar com ela.
  IF EXISTS (SELECT 1 FROM public.kidmais062_ocupacoes_escopo('-infinity'::date, 'infinity'::date) o
               JOIN public.bloqueios_agenda b ON b.ativo AND b.data = o.data
                AND (b.dia_inteiro OR b.horario_inicio IS NULL OR b.horario_fim IS NULL OR (b.horario_inicio < o.horario_fim AND b.horario_fim > o.horario_inicio))
              WHERE NOT public.kidmais062_bloqueio_aplica(b.empresa_id, b.estabelecimento_id, o.empresa_id, o.estabelecimento_id)) THEN
    RAISE EXCEPTION 'Rollback 062 recusado: há bloqueio de empresa/unidade no horário de reserva de outro recurso; a agenda global os tornaria conflitantes. Desative o bloqueio por decisão explícita ou corrija para frente.';
  END IF;
END $$;
DROP TRIGGER contrato_importacoes_062_unidade_trg ON public.contrato_importacoes;
DROP TRIGGER fechamento_revisoes_062_unidade_trg ON public.fechamento_revisoes;
DROP TRIGGER configuracao_agenda_062_unidade_trg ON public.configuracao_agenda;
DROP TRIGGER bloqueios_agenda_062_unidade_trg ON public.bloqueios_agenda;
DROP TRIGGER contrato_fluxos_062_unidade_trg ON public.contrato_fluxos;
DROP TRIGGER fechamentos_062_unidade_trg ON public.fechamentos;
CREATE OR REPLACE FUNCTION public.kidmais019_validar_destino(cid uuid) RETURNS void
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
CREATE OR REPLACE FUNCTION public.kidmais_proteger_bloqueio_revisao() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' THEN PERFORM public.kidmais_lock_datas_revisao(ARRAY[OLD.data,NEW.data]); ELSE PERFORM public.kidmais_lock_datas_revisao(ARRAY[NEW.data]); END IF;
 IF NOT NEW.ativo THEN RETURN NEW; END IF;
 IF EXISTS(SELECT 1 FROM public.kidmais_ocupacoes_operacionais(NEW.data,NEW.data) o WHERE
 (NEW.dia_inteiro OR NEW.horario_inicio IS NULL OR NEW.horario_fim IS NULL OR (o.horario_inicio<NEW.horario_fim AND o.horario_fim>NEW.horario_inicio)))
 THEN RAISE EXCEPTION 'Bloqueio conflita com contratação vigente' USING ERRCODE='23514'; END IF;
 RETURN NEW;
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
 IF EXISTS(SELECT 1 FROM public.kidmais_ocupacoes_operacionais(target_day,target_day) o WHERE o.fechamento_id<>fid AND o.horario_inicio<fim AND o.horario_fim>ini) OR EXISTS(SELECT 1 FROM public.bloqueios_agenda b WHERE b.ativo AND b.data=target_day AND (b.dia_inteiro OR b.horario_inicio IS NULL OR b.horario_fim IS NULL OR (b.horario_inicio<fim AND b.horario_fim>ini))) THEN RAISE EXCEPTION 'Conflito de agenda da revisão' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
DROP FUNCTION public.kidmais062_vinculo_unidade();
DROP FUNCTION public.kidmais062_revisao_unidade();
DROP FUNCTION public.kidmais062_unidade_ativa();
DROP FUNCTION public.kidmais062_fluxo_unidade();
DROP FUNCTION public.kidmais062_unidade_fechamento();
DROP FUNCTION public.kidmais062_ocupacoes_escopo(date, date);
DROP FUNCTION public.kidmais062_unidade_agendavel(uuid, uuid);
DROP FUNCTION public.kidmais062_travar_habilitacao(uuid);
DROP FUNCTION public.kidmais062_operador_agenda(uuid, uuid, text);
DROP FUNCTION public.kidmais062_bloqueio_aplica(uuid, uuid, uuid, uuid);
DROP FUNCTION public.kidmais062_mesmo_recurso(uuid, uuid, uuid, uuid);
DO $estrutura$ BEGIN
  IF EXISTS (SELECT 1 FROM public.fechamentos WHERE estabelecimento_id IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public.bloqueios_agenda WHERE empresa_id IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public.configuracao_agenda WHERE empresa_id IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public.agenda_062_bloqueios_resolucao)
     OR EXISTS (SELECT 1 FROM public.agenda_062_fechamentos_resolucao)
     OR EXISTS (SELECT 1 FROM public.agenda_062_unidades_habilitacao) THEN
    RAISE NOTICE 'Rollback 062 SUAVE: escopos e habilitações preservados (colunas, decisões D2/D3 e histórico de habilitação com a guarda); agenda global ativa.';
    RETURN;
  END IF;
  DROP TABLE public.agenda_062_unidades_habilitacao;
  DROP FUNCTION public.kidmais062_habilitacao_guard();
  DROP TABLE public.agenda_062_fechamentos_resolucao;
  DROP TABLE public.agenda_062_bloqueios_resolucao;
  DROP INDEX public.configuracao_agenda_062_codigo_escopo_uk;
  DROP INDEX public.bloqueios_agenda_062_escopo_idx;
  DROP INDEX public.fechamentos_062_agenda_idx;
  ALTER TABLE public.configuracao_agenda DROP CONSTRAINT configuracao_agenda_062_estabelecimento_fk,
    DROP CONSTRAINT configuracao_agenda_062_unidade_exige_empresa_check, DROP COLUMN estabelecimento_id, DROP COLUMN empresa_id,
    ADD CONSTRAINT configuracao_agenda_codigo_uk UNIQUE (codigo);
  ALTER TABLE public.bloqueios_agenda DROP CONSTRAINT bloqueios_agenda_062_estabelecimento_fk,
    DROP CONSTRAINT bloqueios_agenda_062_unidade_exige_empresa_check, DROP COLUMN estabelecimento_id, DROP COLUMN empresa_id;
  ALTER TABLE public.fechamentos DROP CONSTRAINT fechamentos_062_estabelecimento_fk,
    DROP CONSTRAINT fechamentos_062_unidade_exige_empresa_check, DROP COLUMN estabelecimento_id;
  RAISE NOTICE 'Rollback 062 COMPLETO: estrutura removida; schema igual ao da 061.';
END $estrutura$;
DO $$ BEGIN
  IF (SELECT encode(sha256(convert_to(replace(prosrc, E'\r', ''), 'UTF8')), 'hex') FROM pg_proc WHERE oid = 'public.kidmais019_validar_destino(uuid)'::regprocedure) IS DISTINCT FROM '2ace64d66008e23d1947b7ba13d1241934554c8886984515d4ca8f776b24886b'
     OR (SELECT encode(sha256(convert_to(replace(prosrc, E'\r', ''), 'UTF8')), 'hex') FROM pg_proc WHERE oid = 'public.kidmais019_validar_contrato()'::regprocedure) IS DISTINCT FROM 'f8f40ebe64775e96e93e3847ef78a312792956ebb0f1e2b873800af9536a810b'
     OR (SELECT encode(sha256(convert_to(replace(prosrc, E'\r', ''), 'UTF8')), 'hex') FROM pg_proc WHERE oid = 'public.kidmais_proteger_bloqueio_revisao()'::regprocedure) IS DISTINCT FROM '7b4639279130207c1d3129c463017ebd2468e0aa099c9ba8d5c7de338cdd0871'
     OR (SELECT encode(sha256(convert_to(replace(prosrc, E'\r', ''), 'UTF8')), 'hex') FROM pg_proc WHERE oid = 'public.kidmais_validar_agenda_revisao()'::regprocedure) IS DISTINCT FROM 'b024636bcf77ef5ee67dc47cb3d1c6023054cf606ded79218979c8fbb05de467'
     OR (SELECT encode(sha256(convert_to(replace(prosrc, E'\r', ''), 'UTF8')), 'hex') FROM pg_proc WHERE oid = 'public.kidmais019_ocupa(uuid)'::regprocedure) IS DISTINCT FROM '87131946b52479651484ec9076ce264243e79867ab2bc1f02447c6a2eb0599a3'
     OR (SELECT encode(sha256(convert_to(replace(prosrc, E'\r', ''), 'UTF8')), 'hex') FROM pg_proc WHERE oid = 'public.kidmais_ocupacoes_operacionais(date,date)'::regprocedure) IS DISTINCT FROM '3fb0ae66b6e7f9f12f2382d7dc916fa4b485828716350496cc9839fd6c4d98c5'
     OR (SELECT encode(sha256(convert_to(replace(prosrc, E'\r', ''), 'UTF8')), 'hex') FROM pg_proc WHERE oid = 'public.kidmais019_formalizacao(uuid,uuid)'::regprocedure) IS DISTINCT FROM '1b428128346f7158389c6a3495f72e9c92a39930b2cb4afe571b9aec900a91ba' THEN
    RAISE EXCEPTION 'Rollback 062: corpos restaurados divergem de 019/061.';
  END IF;
END $$;
COMMIT;
