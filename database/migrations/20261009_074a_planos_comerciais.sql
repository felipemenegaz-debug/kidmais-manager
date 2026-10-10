-- 074 — Estrutura dos três planos, isenção permanente e campanha Fundador.
-- Homologada em base sintética reduzida; NÃO aplicada em staging/produção. Não migra, isenta ou cobra empresas existentes.
-- Exige 063/067/068; preparada para o cadastro 069. Aplicação exige autorização própria e homologação PostgreSQL isolada.
-- Concessão/pagamento só pelo servidor confiável; constraints não consultam o Asaas.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = public, pg_catalog;

DO $$ BEGIN
  IF to_regclass('public.empresa_assinaturas') IS NULL
     OR to_regclass('public.cobranca_eventos') IS NULL
     OR to_regclass('public.plataforma_empresas_cadastro') IS NULL
     OR to_regprocedure('public.kidmais_068_assinatura_guarda()') IS NULL THEN
    RAISE EXCEPTION '074 exige modelo comercial, cobrança e cadastro instalados.';
  END IF;
  IF to_regclass('public.assinatura_contratacoes') IS NOT NULL
     OR to_regclass('public.assinatura_isencoes') IS NOT NULL
     OR to_regclass('public.assinatura_fundadores') IS NOT NULL THEN
    RAISE EXCEPTION '074 já aplicada total ou parcialmente.';
  END IF;
END $$;
LOCK TABLE empresa_assinaturas IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  -- Recusa substituir uma guarda alterada por outra entrega. Hash do corpo 068 sem whitespace.
  IF (SELECT md5(regexp_replace(prosrc, '[[:space:]]', '', 'g')) FROM pg_proc
      WHERE oid = 'public.kidmais_068_assinatura_guarda()'::regprocedure)
      IS DISTINCT FROM '6587469604572b17146a1346a8c01c47' THEN
    RAISE EXCEPTION '074: guarda 068 divergiu da base revisada; reconciliar antes de aplicar.';
  END IF;
END $$;

-- Isenção concedida por operador da plataforma à empresa persistida verificada.
-- Sem INSERT da Kidmais: confirmar ID e documento numa operação posterior autorizada.
CREATE TABLE assinatura_isencoes (
  empresa_id uuid PRIMARY KEY REFERENCES empresas(id),
  documento_verificado text NOT NULL UNIQUE CHECK (documento_verificado ~ '^[0-9A-Z]{12}[0-9]{2}$'),
  motivo text NOT NULL CHECK (char_length(btrim(motivo)) BETWEEN 5 AND 500),
  concedida_por uuid NOT NULL REFERENCES usuarios_administrativos(id),
  concedida_em timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Até 20 vagas ocupadas: o índice parcial é a proteção contra concorrência.
-- CONFIRMADA nunca volta a LIBERADA. LIBERADA exige prova de cobrança não mais pagável.
CREATE TABLE assinatura_fundadores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresa_assinaturas(empresa_id),
  documento_beneficiario text NOT NULL CHECK (documento_beneficiario ~ '^[0-9A-Z]{12}[0-9]{2}$'),
  vaga smallint NOT NULL CHECK (vaga BETWEEN 1 AND 20),
  estado text NOT NULL DEFAULT 'RESERVADA' CHECK (estado IN ('RESERVADA','CONFIRMADA','LIBERADA')),
  reservada_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  confirmada_em timestamptz,
  beneficio_fim timestamptz,
  pagamento_confirmacao_id text,
  liberada_em timestamptz,
  evidencia_liberacao text,
  CONSTRAINT assinatura_fundadores_empresa_id_uk UNIQUE (empresa_id,id),
  CONSTRAINT assinatura_fundadores_evidencias_check CHECK (
    (estado = 'RESERVADA' AND confirmada_em IS NULL AND beneficio_fim IS NULL AND pagamento_confirmacao_id IS NULL AND liberada_em IS NULL AND evidencia_liberacao IS NULL)
    OR (estado = 'CONFIRMADA' AND confirmada_em IS NOT NULL AND confirmada_em >= reservada_em
        AND beneficio_fim IS NOT NULL AND beneficio_fim > confirmada_em
        AND pagamento_confirmacao_id IS NOT NULL AND char_length(btrim(pagamento_confirmacao_id)) BETWEEN 1 AND 100
        AND liberada_em IS NULL AND evidencia_liberacao IS NULL)
    OR (estado = 'LIBERADA' AND confirmada_em IS NULL AND beneficio_fim IS NULL AND pagamento_confirmacao_id IS NULL
        AND liberada_em IS NOT NULL AND liberada_em >= reservada_em
        AND evidencia_liberacao IS NOT NULL AND char_length(btrim(evidencia_liberacao)) BETWEEN 5 AND 500)
  )
);
CREATE UNIQUE INDEX assinatura_fundadores_vaga_uk ON assinatura_fundadores(vaga) WHERE estado <> 'LIBERADA';
CREATE UNIQUE INDEX assinatura_fundadores_empresa_uk ON assinatura_fundadores(empresa_id) WHERE estado <> 'LIBERADA';
CREATE UNIQUE INDEX assinatura_fundadores_documento_uk ON assinatura_fundadores(documento_beneficiario) WHERE estado <> 'LIBERADA';
CREATE UNIQUE INDEX assinatura_fundadores_pagamento_uk ON assinatura_fundadores(pagamento_confirmacao_id) WHERE pagamento_confirmacao_id IS NOT NULL;

-- Snapshot financeiro imutável. O navegador nunca informa valores ou benefício autorizado.
CREATE TABLE assinatura_contratacoes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresa_assinaturas(empresa_id),
  chave_idempotencia uuid NOT NULL,
  plano text NOT NULL CHECK (plano IN ('ESSENCIAL','PROFISSIONAL','PREMIUM')),
  ciclo text NOT NULL CHECK (ciclo IN ('MENSAL','ANUAL')),
  catalogo_versao text NOT NULL CHECK (char_length(btrim(catalogo_versao)) BETWEEN 1 AND 50),
  valor_regular_centavos integer NOT NULL CHECK (valor_regular_centavos BETWEEN 100 AND 10000000),
  desconto_percentual smallint NOT NULL DEFAULT 0 CHECK (desconto_percentual IN (0,40)),
  valor_final_centavos integer NOT NULL CHECK (valor_final_centavos > 0),
  fundador_id uuid,
  estado text NOT NULL DEFAULT 'EM_ABERTO' CHECK (estado IN ('EM_ABERTO','CONFIRMADA','CANCELADA')),
  criada_por uuid NOT NULL REFERENCES usuarios_administrativos(id),
  criada_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  confirmada_em timestamptz,
  pagamento_confirmacao_id text,
  provedor_assinatura_id text,
  cancelada_em timestamptz,
  motivo_cancelamento text,
  CONSTRAINT assinatura_contratacoes_empresa_id_uk UNIQUE (empresa_id,id),
  CONSTRAINT assinatura_contratacoes_empresa_pagamento_uk UNIQUE (empresa_id,fundador_id,pagamento_confirmacao_id),
  CONSTRAINT assinatura_contratacoes_idempotencia_uk UNIQUE (empresa_id,chave_idempotencia),
  CONSTRAINT assinatura_contratacoes_fundador_fk FOREIGN KEY (empresa_id,fundador_id) REFERENCES assinatura_fundadores(empresa_id,id),
  CONSTRAINT assinatura_contratacoes_desconto_check CHECK (
    (desconto_percentual = 0 AND fundador_id IS NULL OR desconto_percentual = 40 AND fundador_id IS NOT NULL)
    AND valor_final_centavos = round(valor_regular_centavos::numeric * (100 - desconto_percentual) / 100)::integer
  ),
  CONSTRAINT assinatura_contratacoes_evidencias_check CHECK (
    (estado = 'EM_ABERTO' AND confirmada_em IS NULL AND pagamento_confirmacao_id IS NULL AND provedor_assinatura_id IS NULL AND cancelada_em IS NULL AND motivo_cancelamento IS NULL)
    OR (estado = 'CONFIRMADA' AND confirmada_em IS NOT NULL AND confirmada_em >= criada_em
        AND pagamento_confirmacao_id IS NOT NULL AND char_length(btrim(pagamento_confirmacao_id)) BETWEEN 1 AND 100
        AND provedor_assinatura_id IS NOT NULL AND char_length(btrim(provedor_assinatura_id)) BETWEEN 1 AND 100
        AND cancelada_em IS NULL AND motivo_cancelamento IS NULL)
    OR (estado = 'CANCELADA' AND confirmada_em IS NULL AND pagamento_confirmacao_id IS NULL AND provedor_assinatura_id IS NULL
        AND cancelada_em IS NOT NULL AND cancelada_em >= criada_em
        AND motivo_cancelamento IS NOT NULL AND char_length(btrim(motivo_cancelamento)) BETWEEN 5 AND 500)
  )
);
CREATE UNIQUE INDEX assinatura_contratacoes_aberta_uk ON assinatura_contratacoes(empresa_id) WHERE estado = 'EM_ABERTO';
CREATE UNIQUE INDEX assinatura_contratacoes_pagamento_uk ON assinatura_contratacoes(pagamento_confirmacao_id) WHERE pagamento_confirmacao_id IS NOT NULL;

-- Primeira confirmação Fundador e contratação confirmada devem fechar na mesma transação.
ALTER TABLE assinatura_fundadores ADD CONSTRAINT assinatura_fundadores_confirmacao_fk
  FOREIGN KEY (empresa_id,id,pagamento_confirmacao_id)
  REFERENCES assinatura_contratacoes(empresa_id,fundador_id,pagamento_confirmacao_id)
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE empresa_assinaturas
  DROP CONSTRAINT empresa_assinaturas_plano_check,
  ADD CONSTRAINT empresa_assinaturas_plano_check CHECK (plano IN ('UNICO','ESSENCIAL','PROFISSIONAL','PREMIUM')),
  ADD COLUMN contratacao_atual_id uuid,
  ADD CONSTRAINT empresa_assinaturas_contratacao_fk FOREIGN KEY (empresa_id,contratacao_atual_id) REFERENCES assinatura_contratacoes(empresa_id,id),
  ADD CONSTRAINT empresa_assinaturas_contratacao_check CHECK ((plano = 'UNICO') = (contratacao_atual_id IS NULL));

CREATE FUNCTION kidmais_074_registro_guarda() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE f public.assinatura_fundadores%ROWTYPE;
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN
    RAISE EXCEPTION '074: histórico comercial não é apagado.' USING ERRCODE = 'P0001';
  END IF;
  -- Ordem comum à futura aplicação: empresa -> assinatura -> vaga -> contratação.
  PERFORM 1 FROM public.empresas WHERE id = NEW.empresa_id FOR UPDATE;
  IF TG_TABLE_NAME = 'assinatura_isencoes' THEN
    IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Isenção permanente é imutável.'; END IF;
    IF EXISTS (SELECT 1 FROM public.empresa_assinaturas WHERE empresa_id = NEW.empresa_id AND provedor_assinatura_id IS NOT NULL)
       OR EXISTS (SELECT 1 FROM public.assinatura_contratacoes WHERE empresa_id = NEW.empresa_id)
       OR EXISTS (SELECT 1 FROM public.assinatura_fundadores WHERE empresa_id = NEW.empresa_id) THEN
      RAISE EXCEPTION 'Isenção exige revisão: empresa já tem histórico de contratação ou provedor.';
    END IF;
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM public.assinatura_isencoes WHERE empresa_id = NEW.empresa_id) THEN
    RAISE EXCEPTION 'Empresa isenta não contrata nem ocupa vaga Fundador.';
  END IF;
  IF TG_TABLE_NAME = 'assinatura_fundadores' THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW.estado <> 'RESERVADA' THEN RAISE EXCEPTION 'Fundador nasce reservado.'; END IF;
      IF NOT EXISTS (SELECT 1 FROM public.empresa_assinaturas WHERE empresa_id = NEW.empresa_id AND documento_teste = NEW.documento_beneficiario) THEN
        RAISE EXCEPTION 'Beneficiário deve corresponder ao documento persistido da assinatura.';
      END IF;
    ELSE
      IF ROW(NEW.id,NEW.empresa_id,NEW.documento_beneficiario,NEW.vaga,NEW.reservada_em)
         IS DISTINCT FROM ROW(OLD.id,OLD.empresa_id,OLD.documento_beneficiario,OLD.vaga,OLD.reservada_em)
         OR OLD.estado <> 'RESERVADA' OR NEW.estado NOT IN ('CONFIRMADA','LIBERADA') THEN
        RAISE EXCEPTION 'Transição ou identidade da vaga Fundador inválida.';
      END IF;
      IF NEW.estado = 'LIBERADA' AND EXISTS (SELECT 1 FROM public.assinatura_contratacoes WHERE fundador_id = NEW.id AND estado <> 'CANCELADA') THEN
        RAISE EXCEPTION 'Vaga tem contratação aberta ou confirmada; reconciliar antes de liberar.';
      END IF;
      IF NEW.estado = 'CONFIRMADA' THEN
        NEW.beneficio_fim := ((NEW.confirmada_em AT TIME ZONE 'UTC') + interval '12 months') AT TIME ZONE 'UTC';
      END IF;
    END IF;
  ELSE
    IF TG_OP = 'INSERT' THEN
      IF NEW.estado <> 'EM_ABERTO' THEN RAISE EXCEPTION 'Contratação nasce aberta.'; END IF;
    ELSIF ROW(NEW.id,NEW.empresa_id,NEW.chave_idempotencia,NEW.plano,NEW.ciclo,NEW.catalogo_versao,NEW.valor_regular_centavos,NEW.desconto_percentual,NEW.valor_final_centavos,NEW.fundador_id,NEW.criada_por,NEW.criada_em)
       IS DISTINCT FROM ROW(OLD.id,OLD.empresa_id,OLD.chave_idempotencia,OLD.plano,OLD.ciclo,OLD.catalogo_versao,OLD.valor_regular_centavos,OLD.desconto_percentual,OLD.valor_final_centavos,OLD.fundador_id,OLD.criada_por,OLD.criada_em)
       OR OLD.estado <> 'EM_ABERTO' OR NEW.estado NOT IN ('CONFIRMADA','CANCELADA') THEN
      RAISE EXCEPTION 'Oferta imutável ou transição de contratação inválida.';
    END IF;
    IF NEW.fundador_id IS NOT NULL AND NEW.estado <> 'CANCELADA' THEN
      SELECT * INTO f FROM public.assinatura_fundadores WHERE id = NEW.fundador_id AND empresa_id = NEW.empresa_id FOR UPDATE;
      IF NOT FOUND OR f.estado = 'LIBERADA' THEN RAISE EXCEPTION 'Vaga Fundador não está disponível para a empresa.'; END IF;
      IF TG_OP = 'INSERT' AND f.estado = 'CONFIRMADA' AND NEW.criada_em >= f.beneficio_fim THEN
        RAISE EXCEPTION 'Benefício Fundador encerrado.';
      END IF;
      IF NEW.estado = 'CONFIRMADA' AND (f.estado <> 'CONFIRMADA' OR NEW.confirmada_em < f.confirmada_em OR NEW.confirmada_em >= f.beneficio_fim) THEN
        RAISE EXCEPTION 'Confirmação fora da vigência Fundador.';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER assinatura_isencoes_074_guarda BEFORE INSERT OR UPDATE OR DELETE ON assinatura_isencoes FOR EACH ROW EXECUTE FUNCTION kidmais_074_registro_guarda();
CREATE TRIGGER assinatura_fundadores_074_guarda BEFORE INSERT OR UPDATE OR DELETE ON assinatura_fundadores FOR EACH ROW EXECUTE FUNCTION kidmais_074_registro_guarda();
CREATE TRIGGER assinatura_contratacoes_074_guarda BEFORE INSERT OR UPDATE OR DELETE ON assinatura_contratacoes FOR EACH ROW EXECUTE FUNCTION kidmais_074_registro_guarda();
CREATE TRIGGER assinatura_isencoes_074_truncate BEFORE TRUNCATE ON assinatura_isencoes FOR EACH STATEMENT EXECUTE FUNCTION kidmais_074_registro_guarda();
CREATE TRIGGER assinatura_fundadores_074_truncate BEFORE TRUNCATE ON assinatura_fundadores FOR EACH STATEMENT EXECUTE FUNCTION kidmais_074_registro_guarda();
CREATE TRIGGER assinatura_contratacoes_074_truncate BEFORE TRUNCATE ON assinatura_contratacoes FOR EACH STATEMENT EXECUTE FUNCTION kidmais_074_registro_guarda();

-- A guarda 068 é substituída abaixo mantendo todas as transições anteriores.
CREATE OR REPLACE FUNCTION kidmais_068_assinatura_guarda() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Assinatura não é apagada; encerre.' USING ERRCODE = 'P0001'; END IF;
  PERFORM 1 FROM public.empresas WHERE id = NEW.empresa_id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM public.assinatura_isencoes WHERE empresa_id = NEW.empresa_id)
     AND (NEW.provedor_assinatura_id IS NOT NULL OR NEW.plano <> 'UNICO') THEN
    RAISE EXCEPTION 'Empresa isenta não pode receber vínculo de cobrança.';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.plano <> 'UNICO' OR NEW.contratacao_atual_id IS NOT NULL THEN
      RAISE EXCEPTION 'Teste começa sem plano pago.';
    END IF;
    IF NEW.situacao <> 'TESTE' THEN RAISE EXCEPTION 'Assinatura nasce em TESTE.' USING ERRCODE = 'P0001'; END IF;
    NEW.versao := 1;
    NEW.criado_em := clock_timestamp();
    NEW.atualizado_em := NEW.criado_em;
    RETURN NEW;
  END IF;
  IF NEW.empresa_id <> OLD.empresa_id OR NEW.teste_inicio <> OLD.teste_inicio OR NEW.criado_em <> OLD.criado_em
     OR NEW.documento_teste IS DISTINCT FROM OLD.documento_teste THEN
    RAISE EXCEPTION 'Identidade da assinatura é imutável.' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.plano <> 'UNICO' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.assinatura_contratacoes c
      WHERE c.id = NEW.contratacao_atual_id AND c.empresa_id = NEW.empresa_id
        AND c.estado = 'CONFIRMADA' AND c.plano = NEW.plano AND c.ciclo = NEW.ciclo
        AND c.provedor_assinatura_id = NEW.provedor_assinatura_id
    ) THEN RAISE EXCEPTION 'Plano exige contratação confirmada da mesma empresa, ciclo e provedor.'; END IF;
    IF (NEW.plano IS DISTINCT FROM OLD.plano OR NEW.contratacao_atual_id IS DISTINCT FROM OLD.contratacao_atual_id)
       AND NEW.situacao <> 'ATIVA' THEN
      RAISE EXCEPTION 'Plano só é ativado após pagamento confirmado.';
    END IF;
  ELSIF OLD.plano <> 'UNICO' OR NEW.contratacao_atual_id IS NOT NULL THEN
    RAISE EXCEPTION 'Contrato novo não volta implicitamente ao legado.';
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

COMMIT;
