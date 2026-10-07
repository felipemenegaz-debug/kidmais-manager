-- 068 — Cobrança da assinatura (complemento da E3 e base da E8): guarda de transições da assinatura, teste único por
-- CNPJ e espelho dos eventos do provedor de cobrança.
--
-- NÃO APLICADA. Exige a 067 e autorização explícita (docs/OPERACAO_AGENTES.md) para qualquer banco, inclusive staging.
--
--   1. empresa_assinaturas (067) ganha guarda: nasce só em TESTE; empresa, início do teste, plano e documento do teste
--      são imutáveis; o fim do teste só avança e só enquanto em TESTE; versão e atualizado_em mantidos pelo banco;
--      transições explícitas; nunca é apagada. Colunas novas: documento_teste (CNPJ que consumiu o teste, único),
--      provedor_situacao (texto do provedor, só informativo) e sincronizado_em (última reconsulta ao provedor).
--   2. cobranca_eventos: um registro por evento recebido do provedor, UNIQUE(provedor, evento_id) — entrega repetida
--      não gera segundo efeito. Guarda só identificadores (evento, assinatura, cobrança, checkout, referência externa):
--      nenhum nome, documento, e-mail ou valor do pagador. O estado é sempre reconsultado no provedor antes de mudar
--      qualquer coisa, então evento fora de ordem não reverte o estado.
-- Nenhuma linha existente é criada ou alterada: empresas atuais continuam sem assinatura (sem cobrança).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = public, pg_catalog;

DO $$ BEGIN
  IF to_regclass('public.empresa_assinaturas') IS NULL THEN RAISE EXCEPTION '068 exige a 067 (empresa_assinaturas).'; END IF;
  IF to_regclass('public.cobranca_eventos') IS NOT NULL THEN RAISE EXCEPTION '068 já aplicada.'; END IF;
  IF EXISTS (SELECT 1 FROM empresa_assinaturas) THEN
    RAISE EXCEPTION '068 recusada: a 067 já tem assinaturas registradas; revise-as antes de instalar a guarda.';
  END IF;
END $$;

LOCK TABLE empresa_assinaturas IN ACCESS EXCLUSIVE MODE;

-- 1. Assinatura --------------------------------------------------------------------------------------------------------
ALTER TABLE empresa_assinaturas
  ADD COLUMN documento_teste text,
  ADD COLUMN provedor_situacao text,
  ADD COLUMN sincronizado_em timestamptz,
  ADD CONSTRAINT empresa_assinaturas_documento_teste_check CHECK (documento_teste IS NULL OR documento_teste ~ '^[0-9A-Z]{12}[0-9]{2}$'),
  ADD CONSTRAINT empresa_assinaturas_provedor_situacao_check CHECK (provedor_situacao IS NULL OR char_length(provedor_situacao) BETWEEN 1 AND 40),
  -- Teto de sanidade: o teste padrão é configurável (lib/assinatura/configuracao.ts) e extensões são auditadas.
  ADD CONSTRAINT empresa_assinaturas_teste_teto_check CHECK (teste_fim <= teste_inicio + interval '400 days');
-- Um teste por CNPJ, para sempre (assinaturas nunca são apagadas). A pessoa não é limitada: quem administra várias
-- empresas tem um teste por CNPJ.
CREATE UNIQUE INDEX empresa_assinaturas_documento_teste_uk ON empresa_assinaturas (documento_teste) WHERE documento_teste IS NOT NULL;

CREATE FUNCTION kidmais_068_assinatura_guarda() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Assinatura não é apagada; encerre.' USING ERRCODE = 'P0001'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.situacao <> 'TESTE' THEN RAISE EXCEPTION 'Assinatura nasce em TESTE.' USING ERRCODE = 'P0001'; END IF;
    NEW.versao := 1;
    NEW.criado_em := clock_timestamp();
    NEW.atualizado_em := NEW.criado_em;
    RETURN NEW;
  END IF;
  IF NEW.empresa_id <> OLD.empresa_id OR NEW.teste_inicio <> OLD.teste_inicio OR NEW.criado_em <> OLD.criado_em
     OR NEW.plano <> OLD.plano OR NEW.documento_teste IS DISTINCT FROM OLD.documento_teste THEN
    RAISE EXCEPTION 'Identidade da assinatura é imutável.' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.teste_fim < OLD.teste_fim THEN RAISE EXCEPTION 'O fim do teste só avança.' USING ERRCODE = 'P0001'; END IF;
  IF NEW.teste_fim <> OLD.teste_fim AND OLD.situacao <> 'TESTE' THEN
    RAISE EXCEPTION 'O teste só é estendido enquanto a assinatura está em TESTE.' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.provedor_cliente_id IS NOT NULL AND NEW.provedor_cliente_id IS DISTINCT FROM OLD.provedor_cliente_id THEN
    RAISE EXCEPTION 'Cliente no provedor é imutável depois de vinculado.' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.provedor_assinatura_id IS NOT NULL AND NEW.provedor_assinatura_id IS DISTINCT FROM OLD.provedor_assinatura_id
     AND OLD.situacao NOT IN ('TESTE', 'CANCELADA_FIM_PERIODO', 'ENCERRADA') THEN
    RAISE EXCEPTION 'Assinatura no provedor só é trocada depois de cancelada ou encerrada.' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.situacao <> OLD.situacao AND NOT ((OLD.situacao, NEW.situacao) IN (
       ('TESTE', 'ATIVA'), ('TESTE', 'ENCERRADA'),
       ('ATIVA', 'EM_ATRASO'), ('ATIVA', 'CANCELADA_FIM_PERIODO'), ('ATIVA', 'ENCERRADA'),
       ('EM_ATRASO', 'ATIVA'), ('EM_ATRASO', 'CANCELADA_FIM_PERIODO'), ('EM_ATRASO', 'ENCERRADA'),
       ('CANCELADA_FIM_PERIODO', 'ATIVA'), ('CANCELADA_FIM_PERIODO', 'ENCERRADA'),
       ('ENCERRADA', 'ATIVA'))) THEN
    RAISE EXCEPTION 'Transição de assinatura inválida: % → %.', OLD.situacao, NEW.situacao USING ERRCODE = 'P0001';
  END IF;
  NEW.versao := OLD.versao + 1;
  NEW.atualizado_em := clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER empresa_assinaturas_068_guarda_trg BEFORE INSERT OR UPDATE OR DELETE ON empresa_assinaturas
  FOR EACH ROW EXECUTE FUNCTION kidmais_068_assinatura_guarda();

CREATE FUNCTION kidmais_068_sem_truncate() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION '068: % não aceita TRUNCATE.', TG_TABLE_NAME USING ERRCODE = 'P0001';
END $$;
CREATE TRIGGER empresa_assinaturas_068_sem_truncate_trg BEFORE TRUNCATE ON empresa_assinaturas
  FOR EACH STATEMENT EXECUTE FUNCTION kidmais_068_sem_truncate();

-- 2. Eventos do provedor -----------------------------------------------------------------------------------------------
CREATE TABLE cobranca_eventos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provedor text NOT NULL,
  evento_id text NOT NULL,
  tipo text NOT NULL,
  criado_no_provedor text,
  assinatura_provedor_id text,
  cobranca_provedor_id text,
  checkout_provedor_id text,
  referencia_externa text,
  empresa_id uuid REFERENCES empresas (id),
  situacao text NOT NULL DEFAULT 'PENDENTE',
  tentativas integer NOT NULL DEFAULT 0,
  ultimo_erro text,
  recebido_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  processado_em timestamptz,
  CONSTRAINT cobranca_eventos_provedor_check CHECK (provedor IN ('ASAAS')),
  CONSTRAINT cobranca_eventos_evento_check CHECK (char_length(evento_id) BETWEEN 1 AND 200),
  CONSTRAINT cobranca_eventos_tipo_check CHECK (tipo ~ '^[A-Z0-9_]{1,80}$'),
  CONSTRAINT cobranca_eventos_ids_check CHECK (
    char_length(coalesce(criado_no_provedor, '')) <= 40 AND char_length(coalesce(assinatura_provedor_id, '')) <= 100
    AND char_length(coalesce(cobranca_provedor_id, '')) <= 100 AND char_length(coalesce(checkout_provedor_id, '')) <= 100
    AND char_length(coalesce(referencia_externa, '')) <= 200),
  CONSTRAINT cobranca_eventos_situacao_check CHECK (situacao IN ('PENDENTE', 'PROCESSADO', 'IGNORADO', 'FALHOU')),
  CONSTRAINT cobranca_eventos_conclusao_check CHECK ((situacao IN ('PROCESSADO', 'IGNORADO')) = (processado_em IS NOT NULL)),
  CONSTRAINT cobranca_eventos_tentativas_check CHECK (tentativas >= 0),
  CONSTRAINT cobranca_eventos_erro_check CHECK (ultimo_erro IS NULL OR char_length(ultimo_erro) <= 500),
  CONSTRAINT cobranca_eventos_evento_uk UNIQUE (provedor, evento_id)
);
CREATE INDEX cobranca_eventos_pendentes_idx ON cobranca_eventos (recebido_em) WHERE situacao IN ('PENDENTE', 'FALHOU');
CREATE INDEX cobranca_eventos_empresa_idx ON cobranca_eventos (empresa_id, recebido_em DESC) WHERE empresa_id IS NOT NULL;

CREATE FUNCTION kidmais_068_evento_guarda() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Evento de cobrança não é apagado.' USING ERRCODE = 'P0001'; END IF;
  IF NEW.id <> OLD.id OR NEW.provedor <> OLD.provedor OR NEW.evento_id <> OLD.evento_id OR NEW.tipo <> OLD.tipo
     OR NEW.recebido_em <> OLD.recebido_em OR NEW.criado_no_provedor IS DISTINCT FROM OLD.criado_no_provedor
     OR NEW.assinatura_provedor_id IS DISTINCT FROM OLD.assinatura_provedor_id OR NEW.cobranca_provedor_id IS DISTINCT FROM OLD.cobranca_provedor_id
     OR NEW.checkout_provedor_id IS DISTINCT FROM OLD.checkout_provedor_id OR NEW.referencia_externa IS DISTINCT FROM OLD.referencia_externa THEN
    RAISE EXCEPTION 'Evento de cobrança: identidade imutável.' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.empresa_id IS NOT NULL AND NEW.empresa_id IS DISTINCT FROM OLD.empresa_id THEN
    RAISE EXCEPTION 'Evento de cobrança: empresa já resolvida.' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.situacao IN ('PROCESSADO', 'IGNORADO') THEN RAISE EXCEPTION 'Evento de cobrança já concluído.' USING ERRCODE = 'P0001'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cobranca_eventos_068_guarda_trg BEFORE UPDATE OR DELETE ON cobranca_eventos
  FOR EACH ROW EXECUTE FUNCTION kidmais_068_evento_guarda();
CREATE TRIGGER cobranca_eventos_068_sem_truncate_trg BEFORE TRUNCATE ON cobranca_eventos
  FOR EACH STATEMENT EXECUTE FUNCTION kidmais_068_sem_truncate();

COMMENT ON TABLE cobranca_eventos IS '068: eventos do provedor de cobrança (só identificadores); UNIQUE(provedor, evento_id).';
COMMENT ON COLUMN empresa_assinaturas.documento_teste IS '068: CNPJ que consumiu o teste grátis; único.';

COMMIT;
