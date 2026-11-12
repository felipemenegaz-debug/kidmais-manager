-- 098: salão combinado ("salão inteiro"), fase 1 dos salões (proposta revisão 3, APROVADA COM RESSALVAS pelo Astra em
-- 23/10/2026; nota do vault "Saloes fase 1 salao inteiro 20261023").
--   * agenda_saloes.combinado + agenda_saloes.membros (uuid[] 1-D, sem nulos nem repetidos, em ordem crescente, 2 ou
--     mais itens), gravados SÓ no INSERT; id, empresa, unidade, tipo e membros não mudam depois (gatilho);
--   * criação validada com FOR SHARE nos membros (ordem de id) e conferida de novo no COMMIT (gatilho diferido):
--     membros simples, ativos, da mesma empresa e unidade, sem o próprio id; DELETE de salão que é membro é recusado;
--   * conflito por interseção de salões no ramo POR_SALAO de kidmais094_conflito_ocupacao (kidmais098_saloes_cruzam);
--     limite do dia e bloqueio como na 094;
--   * invariante de elegibilidade (kidmais019_validar_contrato e kidmais_validar_agenda_revisao): toda ocupação de hoje
--     em diante (kidmais098_hoje(), America/Sao_Paulo) aponta para salão nulo ou elegível (ativo e, se combinado, com
--     todos os membros ativos); a união ordenada dos salões e membros da origem e do destino é travada FOR SHARE antes
--     da leitura decisiva;
--   * D5 (decisão de Felipe, 23/10): salão, combinado ou membro de combinado com ocupação futura não é desativado;
--   * contratos não são apagados (DELETE/TRUNCATE) e não mudam de festa (fechamento_id imutável).
-- ORDEM: código com o conjunto 098 no manifesto da Festa (lib/festas/estrutura-019.ts) ANTES da 098 (o código aceita
-- 094 e 094 + 098); depois a 098. Exige a 093/094 aplicadas.
-- Executar somente após autorização própria do ambiente, precheck, backup operacional e integridade.
-- Rollback: database/rollback/20261023_098_saloes_combinados_down.sql (recusado se existir qualquer combinado).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;
DO $$
BEGIN
  IF to_regclass('public.agenda_saloes') IS NULL OR to_regclass('public.contratos') IS NULL
    OR to_regprocedure('public.kidmais094_ocupacoes(date,date)') IS NULL
    OR to_regprocedure('public.kidmais094_conflito_ocupacao(uuid,date,time without time zone,time without time zone,uuid,uuid,uuid,uuid)') IS NULL
    OR to_regprocedure('public.kidmais098_hoje()') IS NOT NULL
    OR EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'agenda_saloes'
                AND column_name IN ('combinado', 'membros')) THEN
    RAISE EXCEPTION '098: precheck falhou (093/094 ausentes ou 098 anterior/parcial); nada alterado';
  END IF;
  -- 094 completa: os três corpos que a 098 substitui são exatamente os da 094.
  IF EXISTS (SELECT 1 FROM (VALUES
        ('kidmais094_conflito_ocupacao(uuid,date,time without time zone,time without time zone,uuid,uuid,uuid,uuid)', 'b6aac1c0b99ed64f4dca94fe5d886e5d5892b82888325010e02adc850def8cf6'),
        ('kidmais019_validar_contrato()', '4d462947bc173967fe9ff059a4aa857bd068502c042ae81a97c918e3362bf43e'),
        ('kidmais_validar_agenda_revisao()', '951825ad597495b477963ebb74df0120c1e8f4c59d39f6b7b32f53e5baaea821')) AS e(f, h)
      WHERE (SELECT encode(sha256(convert_to(replace(prosrc, E'\r', ''), 'UTF8')), 'hex') FROM pg_proc WHERE oid = to_regprocedure('public.' || e.f))
            IS DISTINCT FROM e.h) THEN
    RAISE EXCEPTION '098: precheck falhou (corpos da 094 divergentes); nada alterado';
  END IF;
  -- Invariante desde o início: nenhuma ocupação de hoje em diante (São Paulo) em salão inativo.
  IF EXISTS (SELECT 1 FROM kidmais094_ocupacoes((clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date, 'infinity'::date) o
               JOIN agenda_saloes s ON s.id = o.salao_id WHERE NOT s.ativo) THEN
    RAISE EXCEPTION '098: há festa de hoje em diante em salão inativo; corrija com autorização antes; nada alterado';
  END IF;
END $$;

-- "Hoje" da agenda: data de São Paulo no instante da chamada (não o fuso da sessão). Futuro = data >= hoje.
CREATE FUNCTION public.kidmais098_hoje() RETURNS date
LANGUAGE sql VOLATILE SET search_path = public, pg_catalog AS $$
 SELECT (clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date
$$;

-- Forma canônica dos membros: 1-D, começando em 1, sem nulos, sem repetidos, em ordem crescente, 2 ou mais.
CREATE FUNCTION public.kidmais098_membros_canonicos(m uuid[]) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = public, pg_catalog AS $$
 SELECT m IS NOT NULL AND array_ndims(m) = 1 AND array_lower(m, 1) = 1 AND cardinality(m) >= 2
    AND array_position(m, NULL::uuid) IS NULL
    AND m = ARRAY(SELECT DISTINCT x FROM unnest(m) AS u(x) ORDER BY x)
$$;

ALTER TABLE public.agenda_saloes
  ADD COLUMN combinado boolean NOT NULL DEFAULT false,
  ADD COLUMN membros uuid[];
ALTER TABLE public.agenda_saloes ADD CONSTRAINT agenda_saloes_098_membros_check
  CHECK (CASE WHEN combinado THEN kidmais098_membros_canonicos(membros) ELSE membros IS NULL END);

-- Conjunto de salões simples: o próprio salão (simples) ou os membros (combinado).
CREATE FUNCTION public.kidmais098_conjunto(salao uuid) RETURNS uuid[]
LANGUAGE sql STABLE SET search_path = public, pg_catalog AS $$
 SELECT CASE WHEN salao IS NULL THEN NULL ELSE coalesce(
   (SELECT CASE WHEN s.combinado THEN s.membros ELSE ARRAY[s.id] END FROM agenda_saloes s WHERE s.id = salao), ARRAY[salao]) END
$$;

-- Dois salões cruzam quando um deles é nulo (festa sem salão ocupa todos), são o mesmo ou os conjuntos se cruzam.
-- A × B: falso; A × AB e AB × BC: verdadeiro.
CREATE FUNCTION public.kidmais098_saloes_cruzam(a uuid, b uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = public, pg_catalog AS $$
 SELECT a IS NULL OR b IS NULL OR a = b OR kidmais098_conjunto(a) && kidmais098_conjunto(b)
$$;

-- Elegível: nulo, ou ativo e, se combinado, com TODOS os membros presentes, simples e ativos (ausente = inelegível).
CREATE FUNCTION public.kidmais098_salao_elegivel(salao uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = public, pg_catalog AS $$
 SELECT salao IS NULL OR EXISTS (SELECT 1 FROM agenda_saloes s WHERE s.id = salao AND s.ativo
   AND (NOT s.combinado OR (SELECT count(*) FROM agenda_saloes m WHERE m.id = ANY (s.membros) AND m.ativo AND NOT m.combinado)
                           = cardinality(s.membros)))
$$;

-- Invariante da festa: trava a UNIÃO, sem repetidos e em ordem de id, dos salões e membros de todas as ocupações de
-- hoje em diante (origem e destino do hold) ANTES da primeira aquisição; depois, em consulta nova (estado confirmado),
-- recusa ocupação em salão inelegível. Ocupação passada (histórico da 061) é decidida por ocupação, como na 094.
CREATE FUNCTION public.kidmais098_validar_elegibilidade(fid uuid) RETURNS void
LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
DECLARE hoje date := kidmais098_hoje(); travar uuid[];
BEGIN
 IF fid IS NULL THEN RETURN; END IF;
 travar := ARRAY(SELECT DISTINCT x FROM kidmais094_ocupacoes(hoje, 'infinity'::date) o
                  CROSS JOIN LATERAL unnest(ARRAY[o.salao_id] || coalesce(kidmais098_conjunto(o.salao_id), ARRAY[]::uuid[])) AS u(x)
                  WHERE o.fechamento_id = fid AND x IS NOT NULL ORDER BY x);
 IF cardinality(travar) = 0 THEN RETURN; END IF;
 PERFORM 1 FROM agenda_saloes s WHERE s.id = ANY (travar) ORDER BY s.id FOR SHARE;
 IF EXISTS (SELECT 1 FROM kidmais094_ocupacoes(hoje, 'infinity'::date) o
             WHERE o.fechamento_id = fid AND NOT kidmais098_salao_elegivel(o.salao_id)) THEN
  RAISE EXCEPTION '098: salão inativo ou combinado com membro inativo' USING ERRCODE = '23514';
 END IF;
END $$;

-- Identidade imutável, exclusão de membro e D5 (desativação com ocupação futura) em agenda_saloes.
CREATE FUNCTION public.kidmais098_salao_guarda() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN
  IF EXISTS (SELECT 1 FROM agenda_saloes c WHERE c.combinado AND c.membros @> ARRAY[OLD.id]) THEN
   RAISE EXCEPTION '098: salão que faz parte de um salão combinado não é apagado' USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
 END IF;
 IF ROW(NEW.id, NEW.empresa_id, NEW.estabelecimento_id, NEW.combinado, NEW.membros)
    IS DISTINCT FROM ROW(OLD.id, OLD.empresa_id, OLD.estabelecimento_id, OLD.combinado, OLD.membros) THEN
  RAISE EXCEPTION '098: id, empresa, unidade, tipo e membros do salão não mudam' USING ERRCODE = '23514';
 END IF;
 IF OLD.ativo AND NOT NEW.ativo AND EXISTS (
     SELECT 1 FROM kidmais094_ocupacoes(kidmais098_hoje(), 'infinity'::date) o
      WHERE o.salao_id = NEW.id
         OR o.salao_id IN (SELECT c.id FROM agenda_saloes c WHERE c.combinado AND c.membros @> ARRAY[NEW.id])) THEN
  RAISE EXCEPTION '098: salão com festa de hoje em diante; remarque ou cancele antes de desativar' USING ERRCODE = '23514';
 END IF;
 RETURN NEW;
END $$;

-- Criação do combinado: BEFORE INSERT (trava os membros FOR SHARE em ordem de id e valida) e de novo no COMMIT.
CREATE FUNCTION public.kidmais098_combinado_validar() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
DECLARE s agenda_saloes%ROWTYPE;
BEGIN
 IF TG_WHEN = 'AFTER' THEN
  SELECT * INTO s FROM agenda_saloes WHERE id = NEW.id;
  IF NOT FOUND THEN RETURN NULL; END IF;
 ELSE
  s := NEW;
 END IF;
 IF NOT s.combinado THEN
  IF s.membros IS NOT NULL THEN RAISE EXCEPTION '098: salão simples não tem membros' USING ERRCODE = '23514'; END IF;
 ELSE
  IF NOT coalesce(kidmais098_membros_canonicos(s.membros), false) THEN
   RAISE EXCEPTION '098: combinado exige 2 ou mais salões distintos, sem vazios, em ordem crescente' USING ERRCODE = '23514';
  END IF;
  IF s.id = ANY (s.membros) THEN RAISE EXCEPTION '098: combinado não contém a si mesmo' USING ERRCODE = '23514'; END IF;
  PERFORM 1 FROM agenda_saloes m WHERE m.id = ANY (s.membros) ORDER BY m.id FOR SHARE;
  IF (SELECT count(*) FROM agenda_saloes m WHERE m.id = ANY (s.membros) AND NOT m.combinado AND m.ativo
        AND m.empresa_id = s.empresa_id AND m.estabelecimento_id IS NOT DISTINCT FROM s.estabelecimento_id)
     <> cardinality(s.membros) THEN
   RAISE EXCEPTION '098: membros precisam ser salões simples, ativos, da mesma empresa e unidade' USING ERRCODE = '23514';
  END IF;
 END IF;
 IF TG_WHEN = 'AFTER' THEN RETURN NULL; END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION public.kidmais098_proibir_truncate() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
BEGIN
 RAISE EXCEPTION '098: % não aceita TRUNCATE', TG_TABLE_NAME USING ERRCODE = '23514';
END $$;

-- Contrato se cancela, não se apaga; e não muda de festa (a reserva não volta a ocupar sem validação).
CREATE FUNCTION public.kidmais098_contrato_guarda() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION '098: contrato não é apagado; cancele-o' USING ERRCODE = '23514'; END IF;
 IF NEW.fechamento_id IS DISTINCT FROM OLD.fechamento_id THEN
  RAISE EXCEPTION '098: o contrato não muda de festa' USING ERRCODE = '23514';
 END IF;
 RETURN NEW;
END $$;

CREATE TRIGGER agenda_saloes_098_guarda_trg BEFORE UPDATE OR DELETE ON public.agenda_saloes
  FOR EACH ROW EXECUTE FUNCTION public.kidmais098_salao_guarda();
CREATE TRIGGER agenda_saloes_098_combinado_trg BEFORE INSERT ON public.agenda_saloes
  FOR EACH ROW EXECUTE FUNCTION public.kidmais098_combinado_validar();
CREATE CONSTRAINT TRIGGER agenda_saloes_098_combinado_diferido AFTER INSERT ON public.agenda_saloes
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.kidmais098_combinado_validar();
CREATE TRIGGER agenda_saloes_098_truncate_trg BEFORE TRUNCATE ON public.agenda_saloes
  FOR EACH STATEMENT EXECUTE FUNCTION public.kidmais098_proibir_truncate();
CREATE TRIGGER contratos_098_guarda_trg BEFORE DELETE OR UPDATE OF fechamento_id ON public.contratos
  FOR EACH ROW EXECUTE FUNCTION public.kidmais098_contrato_guarda();
CREATE TRIGGER contratos_098_truncate_trg BEFORE TRUNCATE ON public.contratos
  FOR EACH STATEMENT EXECUTE FUNCTION public.kidmais098_proibir_truncate();

-- Regra física (POR_SALAO): o salão conflita por interseção de conjuntos (corpo da 094, uma cláusula trocada).
CREATE OR REPLACE FUNCTION public.kidmais094_conflito_ocupacao(fid uuid, dia date, ini time, fim time, emp uuid, uni uuid, cfg uuid, salao uuid)
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
                      AND kidmais098_saloes_cruzam(o.salao_id, salao)
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

-- Invariante de elegibilidade (corpos da 094 com UMA linha a mais cada): toda ocupação futura da festa aponta para
-- salão nulo ou elegível; salão e membros travados por último, na validação diferida.
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
 IF kidmais019_ocupa(fid) THEN PERFORM kidmais098_validar_elegibilidade(fid); END IF;
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
 PERFORM public.kidmais098_validar_elegibilidade(fid);
 IF public.kidmais094_conflito_ocupacao(fid,target_day,ini,fim,f.empresa_id,f.estabelecimento_id,
   CASE WHEN TG_TABLE_NAME='fechamentos' THEN f.configuracao_agenda_id ELSE r.configuracao_agenda_id END,
   CASE WHEN TG_TABLE_NAME='fechamentos' THEN f.salao_id ELSE COALESCE(r.salao_id,f.salao_id) END)
 OR EXISTS(SELECT 1 FROM public.bloqueios_agenda b WHERE b.ativo AND b.data=target_day AND public.kidmais062_bloqueio_aplica(b.empresa_id,b.estabelecimento_id,f.empresa_id,f.estabelecimento_id)
   AND (b.dia_inteiro OR b.horario_inicio IS NULL OR b.horario_fim IS NULL OR (b.horario_inicio<fim AND b.horario_fim>ini))) THEN RAISE EXCEPTION 'Conflito de agenda da revisão' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;


COMMIT;
