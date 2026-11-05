-- 114 (D-LIB-6, plano "liberar agenda com mais de um salão" rev. 3, aprovada pelo Astra na rev. 7; decisão de Felipe em
-- 31/10/2026): os gatilhos da 019 que tomam as datas da agenda em fechamentos, contratos, contrato_fluxos e
-- fechamento_revisoes passam a VERIFICAR (nunca adquirir) que a configuração da agenda da empresa
-- (advisory kidmais:agenda-config:<empresa>, compartilhada ou exclusiva) já está travada nesta transação. Sem ela, o
-- gatilho levanta KD114 e a transação volta: um escritor esquecido falha, seja serviço, DML direto ou script.
--   * kidmais019_lock_ocupacao (BEFORE, as quatro tabelas): verificação antes de kidmais_lock_datas_revisao e de
--     kidmais019_bloquear_contrato;
--   * kidmais_validar_agenda_revisao (constraint trigger adiado, fechamentos e fechamento_revisoes): verificação antes da
--     data do destino. No COMMIT as travas xact ainda estão seguras.
-- Corpos recriados a partir do pg_get_functiondef ATUAL (cadeia 109 sem a 098, a de staging); o diff função a função está no
-- pacote de revisão. Fechamento legado sem empresa (empresa_id nulo, anterior à 054) não tem configuração a proteger: passa.
-- Mesmos critérios da guarda em TypeScript (lib/agenda/trava-configuracao.ts): pg_locks advisory concedida, banco atual,
-- próprio backend, objsubid = 1 e as duas metades de hashtextextended('kidmais:agenda-config:' || empresa, 0).
-- Precheck: os dois corpos atuais têm de ser os da cadeia 108/109 (hash do prosrc); outra forma recusa sem alterar nada.
-- Executar somente após autorização própria do ambiente e só DEPOIS do código que trava as entradas.
-- Rollback: database/rollback/20261031_114_trava_configuracao_gatilhos_down.sql.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;

DO $precheck$ BEGIN
 IF to_regprocedure('public.kidmais114_exigir_configuracao(uuid)') IS NOT NULL THEN RAISE EXCEPTION '114: precheck falhou (já aplicada)'; END IF;
 IF (SELECT encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex') FROM pg_proc WHERE oid='public.kidmais019_lock_ocupacao()'::regprocedure)
    IS DISTINCT FROM 'eb5f187f7ef5e7a499413d71cc1a0c5023d65080920997248a7f5d1947460880'
 OR (SELECT encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex') FROM pg_proc WHERE oid='public.kidmais_validar_agenda_revisao()'::regprocedure)
    IS DISTINCT FROM '8476ec76d2ae8af4f7fbbdba595b0fd82b8060c76be4d2d915a47451f11f9e24'
 THEN RAISE EXCEPTION '114: precheck falhou (corpos atuais divergentes dos da cadeia 108/109)'; END IF;
END $precheck$;

CREATE FUNCTION public.kidmais114_exigir_configuracao(emp uuid) RETURNS void
LANGUAGE plpgsql STABLE SET search_path = public, pg_catalog AS $fn$
DECLARE k bigint;
BEGIN
 IF emp IS NULL THEN RETURN; END IF;
 k := hashtextextended('kidmais:agenda-config:' || emp::text, 0);
 IF NOT EXISTS (SELECT 1 FROM pg_locks l
   WHERE l.locktype = 'advisory' AND l.granted AND l.pid = pg_backend_pid()
     AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
     AND l.objsubid = 1
     AND l.classid::bigint = ((k >> 32) & 4294967295)
     AND l.objid::bigint = (k & 4294967295)
     AND l.mode IN ('ShareLock', 'ExclusiveLock'))
 THEN RAISE EXCEPTION 'Trava da configuração da agenda ausente nesta transação (empresa %)', emp
   USING ERRCODE = 'KD114', HINT = 'A entrada toma kidmais:agenda-config:<empresa> antes das datas (travarConfiguracaoAgenda).';
 END IF;
END $fn$;

CREATE OR REPLACE FUNCTION public.kidmais019_lock_ocupacao() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
DECLARE cid uuid; emp uuid;
BEGIN
 -- 114 (D-LIB-6): a configuração da agenda da empresa precisa estar travada nesta transação ANTES das datas.
 IF TG_TABLE_NAME='fechamentos' THEN emp:=NEW.empresa_id;
  IF TG_OP='UPDATE' AND OLD.empresa_id IS DISTINCT FROM NEW.empresa_id THEN PERFORM kidmais114_exigir_configuracao(OLD.empresa_id); END IF;
 ELSIF TG_TABLE_NAME='contratos' THEN SELECT f.empresa_id INTO emp FROM fechamentos f WHERE f.id=NEW.fechamento_id;
 ELSIF TG_TABLE_NAME='fechamento_revisoes' THEN SELECT f.empresa_id INTO emp FROM fechamentos f WHERE f.id=NEW.fechamento_id;
 ELSE SELECT f.empresa_id INTO emp FROM contratos c JOIN fechamentos f ON f.id=c.fechamento_id WHERE c.id=NEW.contrato_id;
 END IF;
 PERFORM kidmais114_exigir_configuracao(emp);
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
 -- 114 (D-LIB-6): a configuração da agenda da empresa precisa estar travada nesta transação ANTES da data.
 PERFORM public.kidmais114_exigir_configuracao(f.empresa_id);
 PERFORM public.kidmais_lock_datas_revisao(ARRAY[target_day]);
 PERFORM public.kidmais098_validar_elegibilidade(fid);
 IF public.kidmais094_conflito_ocupacao(fid,target_day,ini,fim,f.empresa_id,f.estabelecimento_id,
   CASE WHEN TG_TABLE_NAME='fechamentos' THEN f.configuracao_agenda_id ELSE r.configuracao_agenda_id END,
   CASE WHEN TG_TABLE_NAME='fechamentos' THEN f.salao_id ELSE COALESCE(r.salao_id,f.salao_id) END)
 OR EXISTS(SELECT 1 FROM public.bloqueios_agenda b WHERE b.ativo AND b.data=target_day AND public.kidmais062_bloqueio_aplica(b.empresa_id,b.estabelecimento_id,f.empresa_id,f.estabelecimento_id)
   AND (b.dia_inteiro OR b.horario_inicio IS NULL OR b.horario_fim IS NULL OR (b.horario_inicio<fim AND b.horario_fim>ini))) THEN RAISE EXCEPTION 'Conflito de agenda da revisão' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;

DO $postcheck$ BEGIN
 IF (SELECT encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex') FROM pg_proc WHERE oid='public.kidmais019_lock_ocupacao()'::regprocedure)
    IS DISTINCT FROM '2518c5bf7646946705955cd2875c09d432935d02f42a1d6f276e14f4b9c9dfd0'
 OR (SELECT encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex') FROM pg_proc WHERE oid='public.kidmais_validar_agenda_revisao()'::regprocedure)
    IS DISTINCT FROM 'dcbfd2b296635249273d36a2593baf15eefb27fa9628523357df4b56476638a1'
 THEN RAISE EXCEPTION '114: postcheck falhou'; END IF;
END $postcheck$;
COMMIT;
