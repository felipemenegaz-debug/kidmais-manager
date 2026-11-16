-- 122: funil derivado dos estados, ações comerciais manuais e perdas.
-- Só aplicar em ambiente autorizado. Não altera cancelamento de contrato assinado.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
ALTER TABLE marketing_contatos ADD COLUMN responsavel_id uuid REFERENCES usuarios_administrativos(id),
  ADD COLUMN perda_motivo text, ADD COLUMN perda_observacao text, ADD COLUMN perdida_em timestamptz;
ALTER TABLE fechamentos ADD COLUMN perda_motivo text, ADD COLUMN perda_observacao text, ADD COLUMN perdida_em timestamptz,
  ADD COLUMN confirmada_em timestamptz;
ALTER TABLE marketing_contatos ADD CONSTRAINT oportunidades_contato_perda_ck CHECK (
  (perda_motivo IS NULL AND perdida_em IS NULL AND perda_observacao IS NULL) OR
  (status='DESCARTADO' AND perdida_em IS NOT NULL AND perda_motivo IN ('Preço','Data ocupada','Fechou com outro buffet','Desistiu da festa','Parou de responder','Outro')));
ALTER TABLE fechamentos ADD CONSTRAINT oportunidades_fechamento_perda_ck CHECK (
  (perda_motivo IS NULL AND perdida_em IS NULL AND perda_observacao IS NULL) OR
  (status IN ('CANCELADO','RECUSADO','EXPIRADO') AND perdida_em IS NOT NULL AND perda_motivo IN ('Preço','Data ocupada','Fechou com outro buffet','Desistiu da festa','Parou de responder','Outro')));
CREATE TABLE oportunidades_acoes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), empresa_id uuid NOT NULL REFERENCES empresas(id),
  contato_id uuid REFERENCES marketing_contatos(id), fechamento_id uuid REFERENCES fechamentos(id),
  responsavel_id uuid NOT NULL REFERENCES usuarios_administrativos(id),
  tipo text NOT NULL CHECK (tipo IN ('Ligar','WhatsApp','Enviar proposta','Visita','Cobrar')),
  data date NOT NULL, observacao text CHECK (length(observacao)<=1000),
  criada_em timestamptz NOT NULL DEFAULT clock_timestamp(), criada_por uuid NOT NULL REFERENCES usuarios_administrativos(id),
  encerrada_em timestamptz, resultado text CHECK (resultado IN ('FEITA','SUBSTITUIDA','PERDIDA','CONVERTIDA')),
  CHECK (num_nonnulls(contato_id,fechamento_id)=1), CHECK ((encerrada_em IS NULL)=(resultado IS NULL))
);
CREATE UNIQUE INDEX oportunidades_acao_contato_aberta ON oportunidades_acoes(empresa_id,contato_id) WHERE encerrada_em IS NULL;
CREATE UNIQUE INDEX oportunidades_acao_fechamento_aberta ON oportunidades_acoes(empresa_id,fechamento_id) WHERE encerrada_em IS NULL;
CREATE INDEX oportunidades_acoes_dia ON oportunidades_acoes(empresa_id,responsavel_id,data) WHERE encerrada_em IS NULL;
-- Marcos observados, sem inferir passagem por uma etapa a partir de uma etapa posterior.
CREATE TABLE oportunidades_marcos (
  empresa_id uuid NOT NULL REFERENCES empresas(id), fechamento_id uuid NOT NULL REFERENCES fechamentos(id),
  etapa text NOT NULL CHECK (etapa IN ('Proposta','Contrato','Sinal','Fechada')),
  ocorrido_em timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(empresa_id,fechamento_id,etapa)
);
CREATE FUNCTION oportunidades_integridade() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.contato_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM marketing_contatos WHERE id=NEW.contato_id AND empresa_id=NEW.empresa_id) THEN
    RAISE EXCEPTION 'Contato fora da empresa' USING ERRCODE='23514';
  END IF;
  IF NEW.fechamento_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM fechamentos WHERE id=NEW.fechamento_id AND empresa_id=NEW.empresa_id) THEN
    RAISE EXCEPTION 'Negociação fora da empresa' USING ERRCODE='23514';
  END IF;
  IF (TG_OP='INSERT' OR NEW.responsavel_id IS DISTINCT FROM OLD.responsavel_id OR NEW.empresa_id IS DISTINCT FROM OLD.empresa_id) AND NOT EXISTS (SELECT 1 FROM memberships WHERE empresa_id=NEW.empresa_id AND usuario_id=NEW.responsavel_id AND status='ATIVA') THEN
    RAISE EXCEPTION 'Responsável fora da empresa' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER oportunidades_acoes_integridade BEFORE INSERT OR UPDATE ON oportunidades_acoes FOR EACH ROW EXECUTE FUNCTION oportunidades_integridade();
CREATE FUNCTION oportunidades_marcar_etapa() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE etapa_atual text;
BEGIN
  etapa_atual := CASE WHEN NEW.status IN ('RASCUNHO','AGUARDANDO_APROVACAO','APROVADO') THEN 'Proposta'
    WHEN NEW.status='AGUARDANDO_CONTRATO' THEN 'Contrato'
    WHEN NEW.status IN ('CONTRATO_ASSINADO','AGUARDANDO_PAGAMENTO') THEN 'Sinal'
    WHEN NEW.status='CONFIRMADO' THEN 'Fechada' END;
  IF NEW.empresa_id IS NOT NULL AND etapa_atual IS NOT NULL THEN
    INSERT INTO oportunidades_marcos(empresa_id,fechamento_id,etapa) VALUES(NEW.empresa_id,NEW.id,etapa_atual) ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER oportunidades_etapa AFTER INSERT OR UPDATE OF status ON fechamentos FOR EACH ROW EXECUTE FUNCTION oportunidades_marcar_etapa();
CREATE FUNCTION oportunidades_confirmar() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status='CONFIRMADO' AND OLD.status IS DISTINCT FROM 'CONFIRMADO' THEN NEW.confirmada_em=clock_timestamp(); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER oportunidades_confirmada BEFORE UPDATE OF status ON fechamentos FOR EACH ROW EXECUTE FUNCTION oportunidades_confirmar();
-- Estado inicial conhecido; a data histórica de confirmação não é inventada.
INSERT INTO oportunidades_marcos(empresa_id,fechamento_id,etapa)
SELECT empresa_id,id,CASE WHEN status IN ('RASCUNHO','AGUARDANDO_APROVACAO','APROVADO') THEN 'Proposta'
 WHEN status='AGUARDANDO_CONTRATO' THEN 'Contrato' WHEN status IN ('CONTRATO_ASSINADO','AGUARDANDO_PAGAMENTO') THEN 'Sinal' ELSE 'Fechada' END
FROM fechamentos WHERE empresa_id IS NOT NULL AND status IN ('RASCUNHO','AGUARDANDO_APROVACAO','APROVADO','AGUARDANDO_CONTRATO','CONTRATO_ASSINADO','AGUARDANDO_PAGAMENTO','CONFIRMADO');
CREATE TABLE oportunidades_resumos (
 empresa_id uuid NOT NULL REFERENCES empresas(id), usuario_id uuid NOT NULL REFERENCES usuarios_administrativos(id), dia date NOT NULL,
 mensagem jsonb NOT NULL, estado text NOT NULL DEFAULT 'PENDENTE' CHECK (estado IN ('PENDENTE','ENVIADO','FALHOU','OBSOLETO')), enviado_em timestamptz, PRIMARY KEY(empresa_id,usuario_id,dia)
);
COMMIT;
