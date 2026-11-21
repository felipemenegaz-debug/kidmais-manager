-- A projeção 094 já é usada no calendário e nas guardas de formalização e remarcação.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;

CREATE TYPE public.pre_reserva_motivo_sem_garantia AS ENUM (
 'VALOR_DIVERGENTE','MENOS_DE_24_HORAS','PEDIDO_INELEGIVEL','DESTINO_MUDOU','HORARIO_INDISPONIVEL'
);
ALTER TABLE public.pre_reserva_recebimentos ADD COLUMN motivo_sem_garantia public.pre_reserva_motivo_sem_garantia
 CHECK (motivo_sem_garantia IS NULL OR garantia_ate IS NULL);

CREATE OR REPLACE FUNCTION public.kidmais094_ocupacoes(inicio date, fim date)
RETURNS TABLE(fechamento_id uuid, revisao_id uuid, origem text, data date, horario_inicio time, horario_fim time,
              empresa_id uuid, estabelecimento_id uuid, configuracao_agenda_id uuid, salao_id uuid)
LANGUAGE sql STABLE SET search_path = public, pg_catalog AS $$
 SELECT f.id,NULL::uuid,'CONFIRMADA'::text,f.data_evento,f.horario_inicio,f.horario_fim,f.empresa_id,f.estabelecimento_id,f.configuracao_agenda_id,f.salao_id
 FROM fechamentos f WHERE kidmais019_ocupa(f.id) AND NOT kidmais061_historico_passado(f.id) AND f.data_evento BETWEEN inicio AND fim
 UNION ALL SELECT r.fechamento_id,r.id,'REVISAO_DESTINO'::text,r.data_evento,r.horario_inicio,r.horario_fim,f.empresa_id,f.estabelecimento_id,r.configuracao_agenda_id,COALESCE(r.salao_id,f.salao_id)
 FROM fechamento_revisoes r JOIN fechamentos f ON f.id=r.fechamento_id JOIN contrato_fluxos cf ON cf.contrato_id=r.contrato_id
 WHERE kidmais019_ocupa(r.fechamento_id) AND r.estado IN ('EM_ELABORACAO','CONGELADA')
 AND r.hold_destino_adquirido_em IS NOT NULL AND cf.versao_em_preparacao_id=r.contrato_versao_id
 AND cf.versao_vigente_id=r.versao_base_id AND r.data_evento BETWEEN inicio AND fim
 UNION ALL
 SELECT f.id,NULL::uuid,'PRE_RESERVA'::text,(a.inicio_evento AT TIME ZONE 'America/Sao_Paulo')::date,
        (a.inicio_evento AT TIME ZONE 'America/Sao_Paulo')::time,(a.fim_evento AT TIME ZONE 'America/Sao_Paulo')::time,
        a.empresa_id,a.estabelecimento_id,f.configuracao_agenda_id,a.salao_id
 FROM pre_reserva_recebimentos p
 JOIN pre_reserva_aceites a ON (a.empresa_id,a.fechamento_id,a.sequencia)=(p.empresa_id,p.fechamento_id,p.aceite_sequencia)
 JOIN fechamentos f ON f.id=p.fechamento_id
 WHERE p.garantia_ate > statement_timestamp() AND p.encerramento IS NULL
   AND f.status NOT IN ('CANCELADO','RECUSADO','EXPIRADO') AND NOT kidmais019_ocupa(f.id)
   AND (a.inicio_evento AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN inicio AND fim;
$$;

-- Bloqueios administrativos ainda consultam a projeção 062. Compartilhar a mesma origem.
CREATE OR REPLACE FUNCTION public.kidmais062_ocupacoes_escopo(inicio date, fim date)
RETURNS TABLE(fechamento_id uuid, revisao_id uuid, origem text, data date, horario_inicio time, horario_fim time, empresa_id uuid, estabelecimento_id uuid)
LANGUAGE sql STABLE SET search_path = public, pg_catalog AS $$
 SELECT o.fechamento_id,o.revisao_id,o.origem,o.data,o.horario_inicio,o.horario_fim,o.empresa_id,o.estabelecimento_id
 FROM kidmais094_ocupacoes(inicio,fim) o;
$$;

-- BEFOREs na mesma tabela executam em ordem alfabética. Falhar antes de a 130 tomar FOR UPDATE.
CREATE FUNCTION pre_reserva_exigir_configuracao() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
BEGIN
 IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'Motivo do recebimento histórico' USING ERRCODE='23514'; END IF;
 PERFORM kidmais114_exigir_configuracao(NEW.empresa_id);
 RETURN NEW;
END $$;
CREATE TRIGGER a131_config_antes_do_aceite BEFORE INSERT ON pre_reserva_aceites
FOR EACH ROW EXECUTE FUNCTION pre_reserva_exigir_configuracao();
CREATE TRIGGER a131_config_antes_do_recebimento BEFORE INSERT ON pre_reserva_recebimentos
FOR EACH ROW EXECUTE FUNCTION pre_reserva_exigir_configuracao();

CREATE TRIGGER pre_reserva_motivo_historico BEFORE UPDATE OF motivo_sem_garantia ON pre_reserva_recebimentos
FOR EACH ROW WHEN (OLD.motivo_sem_garantia IS DISTINCT FROM NEW.motivo_sem_garantia)
EXECUTE FUNCTION pre_reserva_exigir_configuracao();

-- A garantia segue o destino aceito até vencer ou dar lugar à contratação.
CREATE FUNCTION public.pre_reserva_preservar_destino() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
DECLARE sala uuid;
BEGIN
 SELECT a.salao_id INTO sala FROM pre_reserva_recebimentos p
 JOIN pre_reserva_aceites a USING (empresa_id, fechamento_id)
 WHERE p.fechamento_id=OLD.id AND p.empresa_id=OLD.empresa_id AND a.sequencia=p.aceite_sequencia
   AND p.garantia_ate>statement_timestamp() AND p.encerramento IS NULL;
 IF FOUND AND NOT kidmais019_ocupa(OLD.id) AND OLD.status NOT IN ('CANCELADO','RECUSADO','EXPIRADO')
 AND (ROW(NEW.data_evento,NEW.horario_inicio,NEW.horario_fim,NEW.configuracao_agenda_id,NEW.estabelecimento_id)
      IS DISTINCT FROM ROW(OLD.data_evento,OLD.horario_inicio,OLD.horario_fim,OLD.configuracao_agenda_id,OLD.estabelecimento_id)
      OR (NEW.salao_id IS DISTINCT FROM OLD.salao_id AND NEW.salao_id IS DISTINCT FROM sala)
      OR (NEW.salao_preferido_id IS DISTINCT FROM OLD.salao_preferido_id AND NEW.salao_preferido_id IS DISTINCT FROM sala))
 THEN RAISE EXCEPTION 'Destino protegido pela garantia do sinal' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pre_reserva_destino_garantido BEFORE UPDATE OF data_evento,horario_inicio,horario_fim,configuracao_agenda_id,estabelecimento_id,salao_id,salao_preferido_id
 ON public.fechamentos FOR EACH ROW EXECUTE FUNCTION public.pre_reserva_preservar_destino();

COMMIT;
