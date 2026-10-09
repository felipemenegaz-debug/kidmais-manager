-- Homologada em base sintética reduzida; NÃO aplicada em staging/produção. Exige 074; não altera contratos existentes.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = public, pg_catalog;
CREATE TABLE assinatura_renovacoes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresas(id),
  contratacao_id uuid NOT NULL UNIQUE,
  destinatario_id uuid NOT NULL REFERENCES usuarios_administrativos(id),
  primeiro_vencimento date NOT NULL,
  primeira_data_regular date NOT NULL CHECK (primeira_data_regular > primeiro_vencimento),
  aviso_dias smallint NOT NULL DEFAULT 30 CHECK (aviso_dias = 30),
  mensagem jsonb NOT NULL CHECK (jsonb_typeof(mensagem) = 'object' AND mensagem ?& ARRAY['para','assunto','texto','html','idempotencia']
    AND jsonb_typeof(mensagem->'para') = 'string' AND jsonb_typeof(mensagem->'texto') = 'string'
    AND mensagem->>'idempotencia' = 'kidmais-renovacao/' || id::text),
  estado text NOT NULL DEFAULT 'PENDENTE' CHECK (estado IN ('PENDENTE','AVISANDO','AVISADA','APLICANDO','REGULAR','REVISAO','CANCELADA')),
  aviso_tentado_em timestamptz,
  aviso_enviado_em timestamptz,
  aviso_id_externo text,
  preco_aplicado_em timestamptz,
  ultimo_erro text CHECK (ultimo_erro IS NULL OR ultimo_erro ~ '^[A-Z0-9_]{1,80}$'),
  criado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  atualizado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (empresa_id,contratacao_id) REFERENCES assinatura_contratacoes(empresa_id,id),
  CHECK (aviso_enviado_em IS NULL OR (aviso_tentado_em IS NOT NULL AND aviso_enviado_em >= aviso_tentado_em AND aviso_id_externo IS NOT NULL)),
  CHECK (aviso_enviado_em IS NULL OR (aviso_enviado_em AT TIME ZONE 'America/Sao_Paulo')::date <= primeira_data_regular - aviso_dias),
  CHECK (estado NOT IN ('AVISADA','APLICANDO','REGULAR') OR aviso_enviado_em IS NOT NULL),
  CHECK (estado <> 'REGULAR' OR preco_aplicado_em IS NOT NULL),
  CHECK (preco_aplicado_em IS NULL OR (aviso_enviado_em IS NOT NULL AND preco_aplicado_em >= aviso_enviado_em))
);
CREATE INDEX assinatura_renovacoes_pendentes_idx ON assinatura_renovacoes(estado,primeira_data_regular);

CREATE FUNCTION kidmais_075_renovacao_guarda() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
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
  ELSE
    IF ROW(NEW.id,NEW.empresa_id,NEW.contratacao_id,NEW.destinatario_id,NEW.primeiro_vencimento,NEW.primeira_data_regular,NEW.aviso_dias,NEW.mensagem,NEW.criado_em)
       IS DISTINCT FROM ROW(OLD.id,OLD.empresa_id,OLD.contratacao_id,OLD.destinatario_id,OLD.primeiro_vencimento,OLD.primeira_data_regular,OLD.aviso_dias,OLD.mensagem,OLD.criado_em)
      THEN RAISE EXCEPTION 'Condições e mensagem da renovação são imutáveis.'; END IF;
    IF (OLD.aviso_tentado_em IS NOT NULL AND NEW.aviso_tentado_em IS DISTINCT FROM OLD.aviso_tentado_em)
       OR (OLD.aviso_enviado_em IS NOT NULL AND ROW(NEW.aviso_enviado_em,NEW.aviso_id_externo) IS DISTINCT FROM ROW(OLD.aviso_enviado_em,OLD.aviso_id_externo))
       OR (OLD.preco_aplicado_em IS NOT NULL AND NEW.preco_aplicado_em IS DISTINCT FROM OLD.preco_aplicado_em)
      THEN RAISE EXCEPTION 'Evidências da renovação são imutáveis.'; END IF;
    IF NOT (NEW.estado = OLD.estado OR
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
CREATE TRIGGER assinatura_renovacoes_075_guarda BEFORE INSERT OR UPDATE OR DELETE ON assinatura_renovacoes FOR EACH ROW EXECUTE FUNCTION kidmais_075_renovacao_guarda();
CREATE TRIGGER assinatura_renovacoes_075_truncate BEFORE TRUNCATE ON assinatura_renovacoes FOR EACH STATEMENT EXECUTE FUNCTION kidmais_075_renovacao_guarda();
COMMIT;
