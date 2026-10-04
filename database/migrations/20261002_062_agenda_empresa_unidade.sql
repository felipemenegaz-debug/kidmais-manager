-- 062 — Agenda isolada por empresa e unidade (recurso exclusivo de agenda = unidade; D1).
--
-- NÃO APLICADA. Exige autorização explícita (docs/OPERACAO_AGENTES.md) para qualquer banco, inclusive staging e clones.
-- Ordem obrigatória: código que aceita os conjuntos 019/061/062 publicado ANTES; depois 061; depois 062.
--
-- Regra de conflito: duas ocupações só conflitam no mesmo dia, com horários sobrepostos, e no MESMO RECURSO:
--   kidmais062_mesmo_recurso(e1,u1,e2,u2) = (e1 IS NULL OR e2 IS NULL OR e1=e2) AND (u1 IS NULL OR u2 IS NULL OR u1=u2).
-- Dado sem escopo continua com o alcance de antes (nada é liberado por suposição):
--   * fechamento sem empresa (legado) conflita com todos, como na 019;
--   * fechamento da empresa sem unidade conflita com todas as unidades da empresa;
--   * bloqueio sem empresa (todos os existentes) continua global até resolução explícita (D3);
--   * bloqueio com empresa e sem unidade vale para a empresa inteira; com unidade, só para ela.
-- Locks: o namespace por data (kidmais:agenda:<data>) é mantido de propósito. É mais grosso que o escopo de conflito
-- (serializa a data entre empresas) e por isso seguro em qualquer combinação de código antigo/novo; só custa espera.
-- Unidade (D1) e elegibilidade (D6 = opção A, decidida pelo Felipe em 03/10/2026): a 043 não distingue "unidade
-- ainda não aberta" de "unidade suspensa" — toda unidade nasce e permanece SUSPENSO, sem motivo, e ATIVO está fechado
-- (D03). Por isso o status NUNCA é permissão: a unidade só é elegível com HABILITAÇÃO EXPLÍCITA e auditada
-- (agenda_062_unidades_habilitacao), feita e revogada por Representante autorizado ativo da empresa, com motivo.
-- Nenhuma unidade existente é habilitada pela migration. Suspensão administrativa = revogação da habilitação (com
-- motivo): reservas já gravadas na unidade são preservadas e continuam ocupando; nova contratação, nova unidade em
-- contratação, alteração de data/horário, novo destino de remarcação, novo bloqueio e novo turno na unidade são
-- recusados até nova habilitação. Regra única: kidmais062_unidade_agendavel.
-- Turnos (D5): configuracao_agenda ganha empresa/unidade; as linhas existentes ficam como modelos globais (horários já
-- contratados preservados). Resolução: unidade → empresa → global.
-- Sem backfill de agenda nesta migration: Unidade principal (D2) e propriedade de bloqueios (D3) ficam em
-- database/repairs, com levantamento e resolução explícita.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = public, pg_catalog;

DO $$ BEGIN
  IF to_regprocedure('public.kidmais062_ocupacoes_escopo(date,date)') IS NOT NULL THEN RAISE EXCEPTION '062 já aplicada.'; END IF;
  IF to_regclass('public.contrato_importacoes') IS NULL OR to_regprocedure('public.kidmais061_historico_passado(uuid)') IS NULL THEN
    RAISE EXCEPTION '062 exige a 061 aplicada antes.';
  END IF;
  IF to_regclass('public.estabelecimentos') IS NULL THEN RAISE EXCEPTION '062 exige a 043 (estabelecimentos).'; END IF;
  -- Corpos substituídos: os da 019 (destino, contrato, bloqueio) e os da 061 (agenda da revisão). A 061 também
  -- substitui kidmais_ocupacoes_operacionais, que a 062 NÃO altera (só cria a versão com escopo ao lado).
  IF (SELECT encode(sha256(convert_to(replace(prosrc, E'\r', ''), 'UTF8')), 'hex') FROM pg_proc WHERE oid = 'public.kidmais019_validar_destino(uuid)'::regprocedure) IS DISTINCT FROM '2ace64d66008e23d1947b7ba13d1241934554c8886984515d4ca8f776b24886b'
     OR (SELECT encode(sha256(convert_to(replace(prosrc, E'\r', ''), 'UTF8')), 'hex') FROM pg_proc WHERE oid = 'public.kidmais019_validar_contrato()'::regprocedure) IS DISTINCT FROM 'f8f40ebe64775e96e93e3847ef78a312792956ebb0f1e2b873800af9536a810b'
     OR (SELECT encode(sha256(convert_to(replace(prosrc, E'\r', ''), 'UTF8')), 'hex') FROM pg_proc WHERE oid = 'public.kidmais_proteger_bloqueio_revisao()'::regprocedure) IS DISTINCT FROM '7b4639279130207c1d3129c463017ebd2468e0aa099c9ba8d5c7de338cdd0871'
     OR (SELECT encode(sha256(convert_to(replace(prosrc, E'\r', ''), 'UTF8')), 'hex') FROM pg_proc WHERE oid = 'public.kidmais_validar_agenda_revisao()'::regprocedure) IS DISTINCT FROM 'b024636bcf77ef5ee67dc47cb3d1c6023054cf606ded79218979c8fbb05de467'
     OR (SELECT encode(sha256(convert_to(replace(prosrc, E'\r', ''), 'UTF8')), 'hex') FROM pg_proc WHERE oid = 'public.kidmais_ocupacoes_operacionais(date,date)'::regprocedure) IS DISTINCT FROM '3fb0ae66b6e7f9f12f2382d7dc916fa4b485828716350496cc9839fd6c4d98c5' THEN
    RAISE EXCEPTION '062: corpos de agenda divergem da 019/061.';
  END IF;
END $$;

-- 1. Escopo nos dados de agenda. A estrutura (colunas, restrições, índices e a tabela de resolução) é criada uma vez.
--    O rollback SUAVE da 062 a preserva com as unidades e donos já gravados e remove só as regras; uma reaplicação
--    encontra a estrutura completa e recria apenas as regras. Estrutura parcial = instalação divergente (recusa).
DO $estrutura$
DECLARE pecas integer;
BEGIN
  SELECT count(*) INTO pecas FROM information_schema.columns WHERE table_schema = 'public' AND (
    (table_name = 'fechamentos' AND column_name = 'estabelecimento_id')
    OR (table_name IN ('bloqueios_agenda', 'configuracao_agenda') AND column_name IN ('empresa_id', 'estabelecimento_id')));
  pecas := pecas
    + (CASE WHEN to_regclass('public.agenda_062_unidades_habilitacao') IS NULL THEN 0 ELSE 1 END)
    + (CASE WHEN to_regclass('public.agenda_062_unidades_habilitacao_vigente_uk') IS NULL THEN 0 ELSE 1 END)
    + (SELECT count(*)::integer FROM pg_trigger WHERE NOT tgisinternal AND tgenabled = 'O'
        AND tgname IN ('agenda_062_unidades_habilitacao_guard_trg', 'agenda_062_unidades_habilitacao_truncate_trg'))
    + (SELECT count(*)::integer FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND convalidated AND conname IN (
        'fechamentos_062_estabelecimento_fk', 'fechamentos_062_unidade_exige_empresa_check',
        'bloqueios_agenda_062_estabelecimento_fk', 'bloqueios_agenda_062_unidade_exige_empresa_check',
        'configuracao_agenda_062_estabelecimento_fk', 'configuracao_agenda_062_unidade_exige_empresa_check'))
    + (CASE WHEN to_regclass('public.agenda_062_bloqueios_resolucao') IS NULL THEN 0 ELSE 1 END)
    + (CASE WHEN to_regclass('public.agenda_062_fechamentos_resolucao') IS NULL THEN 0 ELSE 1 END)
    + (CASE WHEN to_regclass('public.configuracao_agenda_062_codigo_escopo_uk') IS NULL THEN 0 ELSE 1 END)
    + (CASE WHEN to_regclass('public.fechamentos_062_agenda_idx') IS NULL THEN 0 ELSE 1 END)
    + (CASE WHEN to_regclass('public.bloqueios_agenda_062_escopo_idx') IS NULL THEN 0 ELSE 1 END);
  IF pecas = 20 AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'configuracao_agenda_codigo_uk') THEN
    PERFORM set_config('kidmais.m062_reaplicacao', 'sim', true);
    RAISE NOTICE '062: estrutura preservada por rollback suave; recriando só as regras.';
    RETURN;
  END IF;
  IF pecas <> 0 THEN RAISE EXCEPTION '062: estrutura parcial (% de 20 peças); instalação divergente.', pecas; END IF;
  PERFORM set_config('kidmais.m062_reaplicacao', 'nao', true);

  ALTER TABLE public.fechamentos ADD COLUMN estabelecimento_id uuid,
    ADD CONSTRAINT fechamentos_062_estabelecimento_fk FOREIGN KEY (empresa_id, estabelecimento_id)
      REFERENCES public.estabelecimentos(empresa_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
    ADD CONSTRAINT fechamentos_062_unidade_exige_empresa_check CHECK (estabelecimento_id IS NULL OR empresa_id IS NOT NULL);
  CREATE INDEX fechamentos_062_agenda_idx ON public.fechamentos (empresa_id, estabelecimento_id, data_evento);

  ALTER TABLE public.bloqueios_agenda ADD COLUMN empresa_id uuid REFERENCES public.empresas(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
    ADD COLUMN estabelecimento_id uuid,
    ADD CONSTRAINT bloqueios_agenda_062_estabelecimento_fk FOREIGN KEY (empresa_id, estabelecimento_id)
      REFERENCES public.estabelecimentos(empresa_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
    ADD CONSTRAINT bloqueios_agenda_062_unidade_exige_empresa_check CHECK (estabelecimento_id IS NULL OR empresa_id IS NOT NULL);
  CREATE INDEX bloqueios_agenda_062_escopo_idx ON public.bloqueios_agenda (empresa_id, estabelecimento_id, data) WHERE ativo;

  ALTER TABLE public.configuracao_agenda ADD COLUMN empresa_id uuid REFERENCES public.empresas(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
    ADD COLUMN estabelecimento_id uuid,
    ADD CONSTRAINT configuracao_agenda_062_estabelecimento_fk FOREIGN KEY (empresa_id, estabelecimento_id)
      REFERENCES public.estabelecimentos(empresa_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
    ADD CONSTRAINT configuracao_agenda_062_unidade_exige_empresa_check CHECK (estabelecimento_id IS NULL OR empresa_id IS NOT NULL),
    DROP CONSTRAINT configuracao_agenda_codigo_uk;
  -- Código único por escopo (global / empresa / unidade); os modelos globais existentes continuam únicos entre si.
  CREATE UNIQUE INDEX configuracao_agenda_062_codigo_escopo_uk ON public.configuracao_agenda
    (coalesce(empresa_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(estabelecimento_id, '00000000-0000-0000-0000-000000000000'::uuid), codigo);

  -- D3: propriedade de bloqueio existente só por decisão explícita (levantamento e aplicação em database/repairs).
  CREATE TABLE public.agenda_062_bloqueios_resolucao (
    bloqueio_id uuid PRIMARY KEY REFERENCES public.bloqueios_agenda(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
    empresa_id uuid NOT NULL REFERENCES public.empresas(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
    estabelecimento_id uuid,
    decidido_por text NOT NULL CHECK (length(btrim(decidido_por)) BETWEEN 3 AND 200),
    motivo text NOT NULL CHECK (length(btrim(motivo)) BETWEEN 5 AND 1000),
    decidido_em timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT agenda_062_bloqueios_resolucao_estabelecimento_fk FOREIGN KEY (empresa_id, estabelecimento_id)
      REFERENCES public.estabelecimentos(empresa_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT
  );

  -- D2: unidade de contratação existente só por decisão explícita, uma linha por contratação (levantamento e aplicação
  -- em database/repairs). Nenhuma atribuição em massa por "a empresa só tem uma unidade".
  CREATE TABLE public.agenda_062_fechamentos_resolucao (
    fechamento_id uuid PRIMARY KEY REFERENCES public.fechamentos(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
    empresa_id uuid NOT NULL,
    estabelecimento_id uuid NOT NULL,
    decidido_por text NOT NULL CHECK (length(btrim(decidido_por)) BETWEEN 3 AND 200),
    motivo text NOT NULL CHECK (length(btrim(motivo)) BETWEEN 5 AND 1000),
    decidido_em timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT agenda_062_fechamentos_resolucao_estabelecimento_fk FOREIGN KEY (empresa_id, estabelecimento_id)
      REFERENCES public.estabelecimentos(empresa_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT
  );

  -- D6 (opção A): habilitação explícita da unidade para agenda. Histórico imutável: só a revogação (uma vez) altera a
  -- linha; nova habilitação depois da revogação é outra linha. No máximo uma habilitação vigente por unidade.
  CREATE TABLE public.agenda_062_unidades_habilitacao (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    empresa_id uuid NOT NULL,
    estabelecimento_id uuid NOT NULL,
    habilitada_por uuid NOT NULL REFERENCES public.usuarios_administrativos(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
    habilitada_papel text NOT NULL,
    motivo_habilitacao text NOT NULL CHECK (length(btrim(motivo_habilitacao)) BETWEEN 5 AND 1000),
    habilitada_em timestamptz NOT NULL DEFAULT clock_timestamp(),
    revogada_por uuid REFERENCES public.usuarios_administrativos(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
    revogada_papel text,
    motivo_revogacao text CHECK (motivo_revogacao IS NULL OR length(btrim(motivo_revogacao)) BETWEEN 5 AND 1000),
    revogada_em timestamptz,
    CONSTRAINT agenda_062_unidades_habilitacao_estabelecimento_fk FOREIGN KEY (empresa_id, estabelecimento_id)
      REFERENCES public.estabelecimentos(empresa_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT agenda_062_unidades_habilitacao_revogacao_ck CHECK (
      (revogada_em IS NULL) = (revogada_por IS NULL) AND (revogada_em IS NULL) = (revogada_papel IS NULL)
      AND (revogada_em IS NULL) = (motivo_revogacao IS NULL) AND (revogada_em IS NULL OR revogada_em >= habilitada_em))
  );
  CREATE UNIQUE INDEX agenda_062_unidades_habilitacao_vigente_uk
    ON public.agenda_062_unidades_habilitacao (estabelecimento_id) WHERE revogada_em IS NULL;

  -- Guarda da habilitação. É ESTRUTURA (fica no rollback suave, protegendo o histórico; sem as regras, nenhuma
  -- habilitação nova nem revogação passa). Nasce vigente, por operador autorizado, para unidade não desativada de
  -- empresa ATIVA; a única alteração é a revogação, uma vez, por operador autorizado e com motivo. Sem DELETE/TRUNCATE.
  CREATE FUNCTION public.kidmais062_habilitacao_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public, pg_catalog AS $guarda$
  BEGIN
   IF TG_OP IN ('DELETE','TRUNCATE') THEN
    RAISE EXCEPTION '062: habilitação de unidade é histórico imutável; use a revogação' USING ERRCODE='23514'; END IF;
   IF TG_OP='INSERT' THEN
    IF NEW.revogada_em IS NOT NULL OR NEW.revogada_por IS NOT NULL OR NEW.revogada_papel IS NOT NULL OR NEW.motivo_revogacao IS NOT NULL THEN
     RAISE EXCEPTION '062: habilitação nasce vigente' USING ERRCODE='23514'; END IF;
    IF NOT EXISTS(SELECT 1 FROM estabelecimentos u JOIN empresas e ON e.id = u.empresa_id
       WHERE u.empresa_id = NEW.empresa_id AND u.id = NEW.estabelecimento_id AND u.status <> 'DESATIVADO' AND e.status = 'ATIVA') THEN
     RAISE EXCEPTION '062: unidade desativada, de outra empresa ou empresa inativa' USING ERRCODE='23514'; END IF;
    IF NOT kidmais062_operador_agenda(NEW.empresa_id, NEW.habilitada_por, NEW.habilitada_papel) THEN
     RAISE EXCEPTION '062: habilitar unidade exige Representante autorizado ativo desta empresa' USING ERRCODE='23514'; END IF;
    NEW.habilitada_em := clock_timestamp();
    RETURN NEW;
   END IF;
   IF OLD.revogada_em IS NOT NULL OR NEW.revogada_por IS NULL
      OR ROW(NEW.id, NEW.empresa_id, NEW.estabelecimento_id, NEW.habilitada_por, NEW.habilitada_papel, NEW.motivo_habilitacao, NEW.habilitada_em)
         IS DISTINCT FROM ROW(OLD.id, OLD.empresa_id, OLD.estabelecimento_id, OLD.habilitada_por, OLD.habilitada_papel, OLD.motivo_habilitacao, OLD.habilitada_em) THEN
    RAISE EXCEPTION '062: só a revogação (uma vez) altera a habilitação' USING ERRCODE='23514'; END IF;
   IF NOT kidmais062_operador_agenda(NEW.empresa_id, NEW.revogada_por, NEW.revogada_papel) THEN
    RAISE EXCEPTION '062: revogar habilitação exige Representante autorizado ativo desta empresa' USING ERRCODE='23514'; END IF;
   NEW.revogada_em := clock_timestamp();
   RETURN NEW;
  END $guarda$;
  CREATE TRIGGER agenda_062_unidades_habilitacao_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON public.agenda_062_unidades_habilitacao
    FOR EACH ROW EXECUTE FUNCTION public.kidmais062_habilitacao_guard();
  CREATE TRIGGER agenda_062_unidades_habilitacao_truncate_trg BEFORE TRUNCATE ON public.agenda_062_unidades_habilitacao
    FOR EACH STATEMENT EXECUTE FUNCTION public.kidmais062_habilitacao_guard();
END $estrutura$;

-- 2. Regras de escopo (puras). Daqui em diante, só regras: criadas na instalação e na reaplicação.
CREATE FUNCTION public.kidmais062_mesmo_recurso(e1 uuid, u1 uuid, e2 uuid, u2 uuid) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
 SELECT (e1 IS NULL OR e2 IS NULL OR e1=e2) AND (u1 IS NULL OR u2 IS NULL OR u1=u2);
$$;

-- Bloqueio sem empresa (legado) é global; com empresa vale para ela; com unidade, só para a unidade. Ocupação sem
-- empresa (legado) é alcançada por qualquer bloqueio.
CREATE FUNCTION public.kidmais062_bloqueio_aplica(be uuid, bu uuid, e uuid, u uuid) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
 SELECT be IS NULL OR e IS NULL OR (be=e AND (bu IS NULL OR u IS NULL OR bu=u));
$$;

-- Operador da agenda por unidade: Representante autorizado (Gestão, 056) com membership ATIVA nesta empresa e
-- identidade ativa. O papel gravado precisa ser o da membership.
CREATE FUNCTION public.kidmais062_operador_agenda(p_empresa uuid, p_usuario uuid, p_papel text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = public, pg_catalog AS $$
 SELECT p_papel = 'REPRESENTANTE_AUTORIZADO' AND EXISTS(SELECT 1 FROM memberships m JOIN usuarios_administrativos ua ON ua.id = m.usuario_id
   WHERE m.empresa_id = p_empresa AND m.usuario_id = p_usuario AND m.status = 'ATIVA' AND m.papel = p_papel AND ua.ativo);
$$;

-- Elegibilidade da unidade para agenda (D6, opção A) — regra ÚNICA, usada pelos gatilhos e pelo código:
-- empresa ATIVA, unidade dela não desativada e habilitação vigente. O status SUSPENSO da 043 não conta.
CREATE FUNCTION public.kidmais062_unidade_agendavel(p_empresa uuid, p_unidade uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = public, pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM estabelecimentos u JOIN empresas e ON e.id = u.empresa_id
   JOIN agenda_062_unidades_habilitacao h ON h.empresa_id = u.empresa_id AND h.estabelecimento_id = u.id AND h.revogada_em IS NULL
   WHERE u.empresa_id = p_empresa AND u.id = p_unidade AND u.status <> 'DESATIVADO' AND e.status = 'ATIVA');
$$;

-- Serializa gravações na unidade com habilitação, revogação e mudança de status da empresa ou da unidade. Ordem ÚNICA
-- de locks da agenda: empresa → unidade → habilitação → data (kidmais:agenda:<data>) → contratação. Quem grava
-- reserva, bloqueio, turno ou destino na unidade trava, nesta ordem, empresa e unidade (FOR SHARE: conflita com
-- UPDATE de status/linha, não entre gravações) e a habilitação vigente (FOR SHARE) antes de conferir a elegibilidade.
-- Habilitar/revogar travam a unidade (FOR NO KEY UPDATE) antes de tocar a habilitação: a mesma ordem, então quem chega
-- depois espera em vez de formar ciclo (o FK de fechamentos/bloqueios só pede KEY SHARE na unidade já travada).
CREATE FUNCTION public.kidmais062_travar_habilitacao(p_unidade uuid) RETURNS void
LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
BEGIN
 PERFORM 1 FROM empresas e WHERE e.id = (SELECT u.empresa_id FROM estabelecimentos u WHERE u.id = p_unidade) FOR SHARE;
 PERFORM 1 FROM estabelecimentos WHERE id = p_unidade FOR SHARE;
 PERFORM 1 FROM agenda_062_unidades_habilitacao WHERE estabelecimento_id = p_unidade AND revogada_em IS NULL FOR SHARE;
END $$;

-- 3. Ocupações com escopo: a mesma seleção da 061 (kidmais_ocupacoes_operacionais, que fica intacta para o código
--    anterior), mais empresa e unidade do fechamento (a revisão herda o escopo do fechamento: remarcação mantém a unidade).
CREATE FUNCTION public.kidmais062_ocupacoes_escopo(inicio date, fim date)
RETURNS TABLE(fechamento_id uuid, revisao_id uuid, origem text, data date, horario_inicio time, horario_fim time, empresa_id uuid, estabelecimento_id uuid)
LANGUAGE sql STABLE SET search_path = public, pg_catalog AS $$
 SELECT f.id,NULL::uuid,'CONFIRMADA'::text,f.data_evento,f.horario_inicio,f.horario_fim,f.empresa_id,f.estabelecimento_id
 FROM fechamentos f WHERE kidmais019_ocupa(f.id) AND NOT kidmais061_historico_passado(f.id) AND f.data_evento BETWEEN inicio AND fim
 UNION ALL SELECT r.fechamento_id,r.id,'REVISAO_DESTINO'::text,r.data_evento,r.horario_inicio,r.horario_fim,f.empresa_id,f.estabelecimento_id
 FROM fechamento_revisoes r JOIN fechamentos f ON f.id=r.fechamento_id JOIN contrato_fluxos cf ON cf.contrato_id=r.contrato_id
 WHERE kidmais019_ocupa(r.fechamento_id) AND r.estado IN ('EM_ELABORACAO','CONGELADA')
 AND r.hold_destino_adquirido_em IS NOT NULL AND cf.versao_em_preparacao_id=r.contrato_versao_id
 AND cf.versao_vigente_id=r.versao_base_id AND r.data_evento BETWEEN inicio AND fim;
$$;

-- 4. Unidade do fechamento: preenchida pelo banco quando a empresa tem exatamente uma unidade ELEGÍVEL (código
--    anterior continua funcionando); nunca muda depois de definida (troca de unidade = nova contratação, D1/V1).
--    Unidade sem habilitação vigente (revogada): a reserva gravada fica como está e continua ocupando; mudar data ou
--    horário dela é recusado (remarcar exige habilitar de novo ou nova contratação em unidade habilitada), e uma
--    proposta antiga que ainda NÃO ocupa não pode passar a CONFIRMADO (confirmação seria nova reserva na unidade).
CREATE FUNCTION public.kidmais062_unidade_fechamento() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
DECLARE unica uuid; n int;
BEGIN
 IF TG_OP='UPDATE' AND OLD.estabelecimento_id IS NOT NULL AND NEW.estabelecimento_id IS DISTINCT FROM OLD.estabelecimento_id THEN
  RAISE EXCEPTION '062: a unidade da contratação não muda; troca de unidade exige nova contratação' USING ERRCODE='23514'; END IF;
 IF NEW.estabelecimento_id IS NULL AND NEW.empresa_id IS NOT NULL AND TG_OP='INSERT' THEN
  SELECT count(*), min(id::text)::uuid INTO n, unica FROM estabelecimentos WHERE empresa_id=NEW.empresa_id AND kidmais062_unidade_agendavel(empresa_id, id);
  IF n=1 THEN NEW.estabelecimento_id := unica; END IF;
 END IF;
 IF NEW.estabelecimento_id IS NOT NULL THEN PERFORM kidmais062_travar_habilitacao(NEW.estabelecimento_id); END IF;
 IF NEW.estabelecimento_id IS NOT NULL AND (TG_OP='INSERT' OR NEW.estabelecimento_id IS DISTINCT FROM OLD.estabelecimento_id)
    AND NOT kidmais062_unidade_agendavel(NEW.empresa_id, NEW.estabelecimento_id) THEN
  RAISE EXCEPTION '062: unidade não elegível para agenda ou de outra empresa' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' AND NEW.estabelecimento_id IS NOT NULL
    AND ROW(NEW.data_evento, NEW.horario_inicio, NEW.horario_fim) IS DISTINCT FROM ROW(OLD.data_evento, OLD.horario_inicio, OLD.horario_fim)
    AND NOT kidmais062_unidade_agendavel(NEW.empresa_id, NEW.estabelecimento_id) THEN
  RAISE EXCEPTION '062: unidade sem habilitação vigente; alterar data ou horário exige unidade habilitada' USING ERRCODE='23514'; END IF;
 -- BEFORE: kidmais019_ocupa ainda lê a linha anterior. Só a proposta que não ocupava é recusada.
 IF TG_OP='UPDATE' AND NEW.estabelecimento_id IS NOT NULL AND NEW.status='CONFIRMADO' AND OLD.status IS DISTINCT FROM 'CONFIRMADO'
    AND NOT kidmais019_ocupa(OLD.id) AND NOT kidmais062_unidade_agendavel(NEW.empresa_id, NEW.estabelecimento_id) THEN
  RAISE EXCEPTION '062: unidade sem habilitação vigente; confirmar nova reserva exige unidade habilitada' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER fechamentos_062_unidade_trg BEFORE INSERT OR UPDATE OF estabelecimento_id, data_evento, horario_inicio, horario_fim, status ON public.fechamentos
  FOR EACH ROW EXECUTE FUNCTION public.kidmais062_unidade_fechamento();

-- Formalização de proposta antiga em unidade revogada: a versão vigente formalizada é a outra porta de entrada da
-- ocupação (kidmais019_ocupa). Trocar a vigente de contratação que ainda NÃO ocupa exige unidade habilitada;
-- reserva já ocupando (preservada pela revogação) segue podendo formalizar revisões sem mudança de horário.
CREATE FUNCTION public.kidmais062_fluxo_unidade() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
DECLARE f fechamentos%ROWTYPE;
BEGIN
 IF NEW.versao_vigente_id IS NULL OR (TG_OP='UPDATE' AND NEW.versao_vigente_id IS NOT DISTINCT FROM OLD.versao_vigente_id) THEN RETURN NEW; END IF;
 -- INSERT ... ON CONFLICT da preparação nativa repete a vigente atual: não é troca.
 IF TG_OP='INSERT' AND EXISTS(SELECT 1 FROM contrato_fluxos WHERE contrato_id = NEW.contrato_id AND versao_vigente_id = NEW.versao_vigente_id) THEN RETURN NEW; END IF;
 SELECT fe.* INTO f FROM contratos c JOIN fechamentos fe ON fe.id = c.fechamento_id WHERE c.id = NEW.contrato_id;
 IF f.estabelecimento_id IS NULL THEN RETURN NEW; END IF;
 PERFORM kidmais062_travar_habilitacao(f.estabelecimento_id);
 IF NOT kidmais019_ocupa(f.id) AND NOT kidmais062_unidade_agendavel(f.empresa_id, f.estabelecimento_id) THEN
  RAISE EXCEPTION '062: unidade sem habilitação vigente; formalizar nova reserva exige unidade habilitada' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER contrato_fluxos_062_unidade_trg BEFORE INSERT OR UPDATE OF versao_vigente_id ON public.contrato_fluxos
  FOR EACH ROW EXECUTE FUNCTION public.kidmais062_fluxo_unidade();

-- Bloqueio e turno na unidade: com habilitação vigente, livres; sem ela (revogada), só desativar ou corrigir a
-- descrição. Criar, reativar, mudar data/horário/período ou mover para a unidade são recusados.
CREATE FUNCTION public.kidmais062_unidade_ativa() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
DECLARE descritivos CONSTANT text[] := ARRAY['motivo', 'observacoes', 'nome', 'ordem_exibicao', 'atualizado_em'];
BEGIN
 IF NEW.estabelecimento_id IS NULL THEN RETURN NEW; END IF;
 PERFORM kidmais062_travar_habilitacao(NEW.estabelecimento_id);
 IF kidmais062_unidade_agendavel(NEW.empresa_id, NEW.estabelecimento_id) THEN RETURN NEW; END IF;
 IF TG_OP='INSERT' OR ROW(NEW.empresa_id, NEW.estabelecimento_id) IS DISTINCT FROM ROW(OLD.empresa_id, OLD.estabelecimento_id) THEN
  RAISE EXCEPTION '062: unidade não elegível para agenda ou de outra empresa' USING ERRCODE='23514'; END IF;
 IF NEW.ativo AND (NOT OLD.ativo OR (to_jsonb(NEW) - descritivos) IS DISTINCT FROM (to_jsonb(OLD) - descritivos)) THEN
  RAISE EXCEPTION '062: unidade sem habilitação vigente; só é possível desativar ou corrigir a descrição' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bloqueios_agenda_062_unidade_trg BEFORE INSERT OR UPDATE ON public.bloqueios_agenda
  FOR EACH ROW EXECUTE FUNCTION public.kidmais062_unidade_ativa();
CREATE TRIGGER configuracao_agenda_062_unidade_trg BEFORE INSERT OR UPDATE ON public.configuracao_agenda
  FOR EACH ROW EXECUTE FUNCTION public.kidmais062_unidade_ativa();

-- Revisão em preparação com destino DIFERENTE do slot atual numa unidade sem habilitação vigente: recusada ao
-- preparar E ao adquirir o hold do destino (hold_destino_adquirido_em: é ele que faz o destino ocupar), mesmo que a
-- revisão tenha sido preparada antes da revogação. Revisão sem mudança de agenda segue normalmente.
CREATE FUNCTION public.kidmais062_revisao_unidade() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
DECLARE f fechamentos%ROWTYPE;
BEGIN
 IF NEW.estado NOT IN ('EM_ELABORACAO','CONGELADA') THEN RETURN NEW; END IF;
 SELECT * INTO f FROM fechamentos WHERE id = NEW.fechamento_id;
 IF f.estabelecimento_id IS NOT NULL THEN PERFORM kidmais062_travar_habilitacao(f.estabelecimento_id); END IF;
 IF f.estabelecimento_id IS NOT NULL
    AND ROW(NEW.data_evento, NEW.horario_inicio, NEW.horario_fim) IS DISTINCT FROM ROW(f.data_evento, f.horario_inicio, f.horario_fim)
    AND NOT kidmais062_unidade_agendavel(f.empresa_id, f.estabelecimento_id) THEN
  RAISE EXCEPTION '062: unidade sem habilitação vigente; alterar data ou horário exige unidade habilitada' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER fechamento_revisoes_062_unidade_trg BEFORE INSERT OR UPDATE OF data_evento, horario_inicio, horario_fim, estado, hold_destino_adquirido_em ON public.fechamento_revisoes
  FOR EACH ROW EXECUTE FUNCTION public.kidmais062_revisao_unidade();

-- Contrato histórico integrado (061): a unidade do vínculo é a mesma da contratação que ele cria.
CREATE FUNCTION public.kidmais062_vinculo_unidade() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
BEGIN
 IF NEW.estabelecimento_id IS DISTINCT FROM (SELECT estabelecimento_id FROM fechamentos WHERE id=NEW.fechamento_id) THEN
  RAISE EXCEPTION '062: unidade do vínculo difere da contratação' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER contrato_importacoes_062_unidade_trg BEFORE INSERT ON public.contrato_importacoes
  FOR EACH ROW EXECUTE FUNCTION public.kidmais062_vinculo_unidade();

-- 5. Conflitos com escopo. Mesmas regras, mensagens e gatilhos da 019/061; muda só o alcance da comparação.
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

CREATE OR REPLACE FUNCTION public.kidmais_proteger_bloqueio_revisao() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' THEN PERFORM public.kidmais_lock_datas_revisao(ARRAY[OLD.data,NEW.data]); ELSE PERFORM public.kidmais_lock_datas_revisao(ARRAY[NEW.data]); END IF;
 IF NOT NEW.ativo THEN RETURN NEW; END IF;
 IF EXISTS(SELECT 1 FROM public.kidmais062_ocupacoes_escopo(NEW.data,NEW.data) o WHERE
 public.kidmais062_bloqueio_aplica(NEW.empresa_id,NEW.estabelecimento_id,o.empresa_id,o.estabelecimento_id) AND
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
 IF EXISTS(SELECT 1 FROM public.kidmais062_ocupacoes_escopo(target_day,target_day) o WHERE o.fechamento_id<>fid AND o.horario_inicio<fim AND o.horario_fim>ini
   AND public.kidmais062_mesmo_recurso(f.empresa_id,f.estabelecimento_id,o.empresa_id,o.estabelecimento_id))
 OR EXISTS(SELECT 1 FROM public.bloqueios_agenda b WHERE b.ativo AND b.data=target_day AND public.kidmais062_bloqueio_aplica(b.empresa_id,b.estabelecimento_id,f.empresa_id,f.estabelecimento_id)
   AND (b.dia_inteiro OR b.horario_inicio IS NULL OR b.horario_fim IS NULL OR (b.horario_inicio<fim AND b.horario_fim>ini))) THEN RAISE EXCEPTION 'Conflito de agenda da revisão' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;

-- 6. A primeira instalação não pode criar conflito nem liberar nada: todo dado existente fica sem escopo (alcance de
--    antes). Na reaplicação depois de rollback suave, o escopo já gravado é o que estava valendo antes do rollback.
DO $$ BEGIN
  IF current_setting('kidmais.m062_reaplicacao') = 'nao' AND (EXISTS(SELECT 1 FROM public.fechamentos WHERE estabelecimento_id IS NOT NULL)
     OR EXISTS(SELECT 1 FROM public.bloqueios_agenda WHERE empresa_id IS NOT NULL)
     OR EXISTS(SELECT 1 FROM public.configuracao_agenda WHERE empresa_id IS NOT NULL)) THEN
    RAISE EXCEPTION '062: a instalação não atribui escopo a dados existentes';
  END IF;
END $$;

COMMENT ON COLUMN public.fechamentos.estabelecimento_id IS '062: unidade (recurso exclusivo de agenda). NULL = toda a empresa (alcance anterior).';
COMMENT ON COLUMN public.bloqueios_agenda.empresa_id IS '062: NULL = bloqueio global legado até resolução explícita (agenda_062_bloqueios_resolucao).';
COMMENT ON TABLE public.agenda_062_unidades_habilitacao IS '062 (D6, opção A): habilitação explícita e auditada da unidade para agenda; revogação = suspensão administrativa (reservas gravadas preservadas).';
COMMENT ON COLUMN public.configuracao_agenda.empresa_id IS '062: NULL = modelo global de turno (linhas existentes; horários contratados preservados).';

COMMIT;
