-- LOCAL, NÃO APLICADA em staging/produção. Exige 075 íntegra (precheck). Plano docs/PLANO_B9_PRODUCAO_PUTS_JANELA_20261029.md
-- rev. 5 (aprovado pelo Astra; D-JP-1..5 de Felipe, 29/10/2026): renovação SUBSTITUTA para a janela de aviso perdida.
-- O registro PENDENTE sem tentativa, com a janela vencida, vira SUBSTITUIDA (terminal) e nasce o sucessor da mesma contratação,
-- com data e mensagem novas. Todos os CHECKs da 075 continuam valendo no sucessor (prazo do aviso, evidências, mensagem).
-- QUEBRA o código anterior (ON CONFLICT (contratacao_id) sem índice inferível): publicar antes o código compatível (§3).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = public, pg_catalog;
LOCK TABLE public.assinatura_renovacoes IN ACCESS EXCLUSIVE MODE;

ALTER TABLE public.assinatura_renovacoes ADD COLUMN substitui_id uuid;
ALTER TABLE public.assinatura_renovacoes ADD CONSTRAINT assinatura_renovacoes_109_substitui_uq UNIQUE (substitui_id);
ALTER TABLE public.assinatura_renovacoes ADD CONSTRAINT assinatura_renovacoes_109_cadeia_alvo_uq UNIQUE (empresa_id, contratacao_id, id);
-- O predecessor é da MESMA empresa e contratação já pela FK composta.
ALTER TABLE public.assinatura_renovacoes ADD CONSTRAINT assinatura_renovacoes_109_cadeia_fk
  FOREIGN KEY (empresa_id, contratacao_id, substitui_id) REFERENCES public.assinatura_renovacoes (empresa_id, contratacao_id, id);
ALTER TABLE public.assinatura_renovacoes DROP CONSTRAINT assinatura_renovacoes_estado_check;
ALTER TABLE public.assinatura_renovacoes ADD CONSTRAINT assinatura_renovacoes_109_estado_check
  CHECK (estado IN ('PENDENTE','AVISANDO','AVISADA','APLICANDO','REGULAR','REVISAO','CANCELADA','SUBSTITUIDA'));
ALTER TABLE public.assinatura_renovacoes ADD CONSTRAINT assinatura_renovacoes_109_substituida_sem_evidencia
  CHECK (estado <> 'SUBSTITUIDA' OR (aviso_tentado_em IS NULL AND aviso_enviado_em IS NULL AND aviso_id_externo IS NULL AND preco_aplicado_em IS NULL));
-- Uma renovação VIGENTE por contratação (antes: uma por contratação).
ALTER TABLE public.assinatura_renovacoes DROP CONSTRAINT assinatura_renovacoes_contratacao_id_key;
CREATE UNIQUE INDEX assinatura_renovacoes_109_vigente_uq ON public.assinatura_renovacoes (contratacao_id) WHERE estado <> 'SUBSTITUIDA';

CREATE FUNCTION public.kidmais_109_renovacao_guarda() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  p record;
  hoje date := (clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date;
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'Histórico de renovação não é apagado.'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.estado <> 'PENDENTE' OR NEW.aviso_tentado_em IS NOT NULL OR NEW.aviso_enviado_em IS NOT NULL
       OR NEW.preco_aplicado_em IS NOT NULL THEN RAISE EXCEPTION 'Renovação nasce pendente.'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.assinatura_contratacoes c
        JOIN public.empresa_assinaturas a ON a.empresa_id = c.empresa_id AND a.contratacao_atual_id = c.id
        JOIN public.assinatura_fundadores f ON f.id = c.fundador_id AND f.empresa_id = c.empresa_id
        WHERE c.id = NEW.contratacao_id AND c.empresa_id = NEW.empresa_id AND c.estado = 'CONFIRMADA'
          AND f.estado = 'CONFIRMADA' AND c.desconto_percentual = 40)
       OR EXISTS (SELECT 1 FROM public.assinatura_isencoes WHERE empresa_id = NEW.empresa_id)
      THEN RAISE EXCEPTION 'Renovação exige contrato Fundador vigente da empresa não isenta.'; END IF;
    IF NEW.substitui_id IS NULL THEN
      IF EXISTS (SELECT 1 FROM public.assinatura_renovacoes WHERE contratacao_id = NEW.contratacao_id)
        THEN RAISE EXCEPTION 'Cadeia de renovação obrigatória: raiz paralela recusada.'; END IF;
    ELSE
      SELECT * INTO p FROM public.assinatura_renovacoes WHERE id = NEW.substitui_id;
      IF NOT FOUND OR p.empresa_id <> NEW.empresa_id OR p.contratacao_id <> NEW.contratacao_id OR p.estado <> 'SUBSTITUIDA'
        THEN RAISE EXCEPTION 'Sucessor exige predecessor substituído da mesma contratação.'; END IF;
      IF p.primeiro_vencimento <> NEW.primeiro_vencimento OR NEW.primeira_data_regular <= p.primeira_data_regular
        THEN RAISE EXCEPTION 'Sucessor exige a mesma âncora e data regular posterior.'; END IF;
      IF NEW.primeira_data_regular < hoje + 30
        THEN RAISE EXCEPTION 'Sucessor exige data regular a pelo menos 30 dias.'; END IF;
    END IF;
  ELSE
    IF OLD.estado = 'SUBSTITUIDA' THEN RAISE EXCEPTION 'Renovação substituída é terminal.'; END IF;
    IF ROW(NEW.id,NEW.empresa_id,NEW.contratacao_id,NEW.destinatario_id,NEW.primeiro_vencimento,NEW.primeira_data_regular,NEW.aviso_dias,NEW.mensagem,NEW.criado_em,NEW.substitui_id)
       IS DISTINCT FROM ROW(OLD.id,OLD.empresa_id,OLD.contratacao_id,OLD.destinatario_id,OLD.primeiro_vencimento,OLD.primeira_data_regular,OLD.aviso_dias,OLD.mensagem,OLD.criado_em,OLD.substitui_id)
      THEN RAISE EXCEPTION 'Condições e mensagem da renovação são imutáveis.'; END IF;
    IF (OLD.aviso_tentado_em IS NOT NULL AND NEW.aviso_tentado_em IS DISTINCT FROM OLD.aviso_tentado_em)
       OR (OLD.aviso_enviado_em IS NOT NULL AND ROW(NEW.aviso_enviado_em,NEW.aviso_id_externo) IS DISTINCT FROM ROW(OLD.aviso_enviado_em,OLD.aviso_id_externo))
       OR (OLD.preco_aplicado_em IS NOT NULL AND NEW.preco_aplicado_em IS DISTINCT FROM OLD.preco_aplicado_em)
      THEN RAISE EXCEPTION 'Evidências da renovação são imutáveis.'; END IF;
    IF NEW.estado = 'SUBSTITUIDA' THEN
      IF OLD.estado <> 'PENDENTE' THEN RAISE EXCEPTION 'Substituição exige renovação pendente.'; END IF;
      IF OLD.aviso_tentado_em IS NOT NULL OR OLD.aviso_enviado_em IS NOT NULL
        THEN RAISE EXCEPTION 'Substituição exige renovação sem tentativa de aviso.'; END IF;
      IF hoje <= OLD.primeira_data_regular - OLD.aviso_dias
        THEN RAISE EXCEPTION 'Substituição exige janela de aviso vencida.'; END IF;
      IF ROW(NEW.aviso_tentado_em,NEW.aviso_enviado_em,NEW.aviso_id_externo,NEW.preco_aplicado_em)
         IS DISTINCT FROM ROW(OLD.aviso_tentado_em,OLD.aviso_enviado_em,OLD.aviso_id_externo,OLD.preco_aplicado_em)
        THEN RAISE EXCEPTION 'Substituição não acrescenta evidência.'; END IF;
    ELSIF NOT (NEW.estado = OLD.estado OR
       (OLD.estado = 'PENDENTE' AND NEW.estado IN ('AVISANDO','REVISAO','CANCELADA')) OR
       (OLD.estado = 'AVISANDO' AND NEW.estado IN ('AVISADA','REVISAO','CANCELADA')) OR
       (OLD.estado = 'AVISADA' AND NEW.estado IN ('APLICANDO','REVISAO','CANCELADA')) OR
       (OLD.estado = 'APLICANDO' AND NEW.estado IN ('REGULAR','REVISAO','CANCELADA')) OR
       (OLD.estado = 'REGULAR' AND NEW.estado IN ('REVISAO','CANCELADA')) OR
       (OLD.estado = 'REVISAO' AND NEW.estado = 'CANCELADA')) THEN RAISE EXCEPTION 'Transição de renovação inválida.'; END IF;
  END IF;
  NEW.atualizado_em := clock_timestamp();
  RETURN NEW;
END $$;

-- Sucessor obrigatório no COMMIT: nenhum predecessor SUBSTITUIDA fica órfão, mesmo fora do repositório.
CREATE FUNCTION public.kidmais_109_renovacao_sucessor() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.estado = 'SUBSTITUIDA' AND NOT EXISTS (SELECT 1 FROM public.assinatura_renovacoes s WHERE s.substitui_id = NEW.id)
    THEN RAISE EXCEPTION 'Renovação substituída exige sucessor na mesma transação.'; END IF;
  RETURN NULL;
END $$;

-- Mesmos nomes de gatilho da 075, ligados à função da 109.
DROP TRIGGER assinatura_renovacoes_075_guarda ON public.assinatura_renovacoes;
DROP TRIGGER assinatura_renovacoes_075_truncate ON public.assinatura_renovacoes;
CREATE TRIGGER assinatura_renovacoes_075_guarda BEFORE INSERT OR UPDATE OR DELETE ON public.assinatura_renovacoes FOR EACH ROW EXECUTE FUNCTION public.kidmais_109_renovacao_guarda();
CREATE TRIGGER assinatura_renovacoes_075_truncate BEFORE TRUNCATE ON public.assinatura_renovacoes FOR EACH STATEMENT EXECUTE FUNCTION public.kidmais_109_renovacao_guarda();
CREATE CONSTRAINT TRIGGER assinatura_renovacoes_109_sucessor AFTER UPDATE ON public.assinatura_renovacoes
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.kidmais_109_renovacao_sucessor();
COMMIT;
