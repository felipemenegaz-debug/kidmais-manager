-- 055a — Kidmais Intelligence (CORE): uso de modelos e reservas de orçamento.
--
-- NÃO APLICADA. Exige autorização explícita (docs/OPERACAO_AGENTES.md) para qualquer banco,
-- inclusive staging e clones. Sem esta migration a IA continua funcionando só com regras
-- determinísticas; orçamento configurado bloqueia chamadas de modelo (fail closed).
--
--   ia_orcamento_reservas  reserva do teto estimado ANTES de cada chamada (reserva → chamada → reconciliação),
--                          com o PERÍODO FIXO (dia e mês em America/Sao_Paulo) do momento da reserva
--   ia_uso_modelo          uma linha por chamada (append-only; sem prompt, sem resposta). Tokens NULL = uso desconhecido.
BEGIN;

DO $$ BEGIN
  IF to_regclass('public.empresas') IS NULL THEN
    RAISE EXCEPTION '055a exige empresas.';
  END IF;
  IF to_regclass('public.ia_uso_modelo') IS NOT NULL OR to_regclass('public.ia_orcamento_reservas') IS NOT NULL THEN
    RAISE EXCEPTION '055a já aplicada.';
  END IF;
END $$;

-- Compartilhada pelas tabelas append-only da IA (055a e 055c).
CREATE FUNCTION kidmais_055_somente_insercao() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION '% é somente inserção.', TG_TABLE_NAME USING ERRCODE = 'P0001';
END $$;

CREATE TABLE ia_orcamento_reservas (
  id uuid PRIMARY KEY,
  empresa_id uuid NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  capacidade varchar(64) NOT NULL CHECK (capacidade ~ '^[a-z_]{1,64}$'),
  correlation_id varchar(100) NOT NULL,
  tokens_reservados integer NOT NULL CHECK (tokens_reservados > 0),
  custo_reservado_micros bigint CHECK (custo_reservado_micros IS NULL OR custo_reservado_micros >= 0),
  moeda char(3) CHECK (moeda IS NULL OR moeda ~ '^[A-Z]{3}$'),
  estado varchar(20) NOT NULL CHECK (estado IN ('ABERTA', 'RECONCILIADA', 'LIBERADA', 'USO_DESCONHECIDO', 'ORFA')),
  criado_em timestamptz NOT NULL,
  encerrado_em timestamptz,
  -- Período contábil fixado na reserva; a reconciliação nunca o recalcula.
  periodo_dia date NOT NULL,
  periodo_mes char(7) NOT NULL,
  CONSTRAINT ia_orcamento_reservas_custo_moeda_check CHECK ((custo_reservado_micros IS NULL) = (moeda IS NULL)),
  CONSTRAINT ia_orcamento_reservas_encerramento_check CHECK ((estado = 'ABERTA') = (encerrado_em IS NULL)),
  CONSTRAINT ia_orcamento_reservas_periodo_check CHECK (periodo_mes = to_char(periodo_dia, 'YYYY-MM'))
);
CREATE INDEX ia_orcamento_reservas_empresa_dia_idx ON ia_orcamento_reservas (empresa_id, periodo_dia);
CREATE INDEX ia_orcamento_reservas_empresa_mes_idx ON ia_orcamento_reservas (empresa_id, periodo_mes);
CREATE INDEX ia_orcamento_reservas_abertas_idx ON ia_orcamento_reservas (criado_em) WHERE estado = 'ABERTA';

-- Reserva sai de ABERTA uma vez (ou de ORFA, numa reconciliação tardia, nunca para LIBERADA), nunca é
-- apagada e nunca muda de dono, valor ou período.
CREATE FUNCTION kidmais_055a_reserva_guarda() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ia_orcamento_reservas não é apagada.' USING ERRCODE = 'P0001';
  END IF;
  IF NOT (OLD.estado = 'ABERTA' OR (OLD.estado = 'ORFA' AND NEW.estado IN ('RECONCILIADA', 'USO_DESCONHECIDO'))) THEN
    RAISE EXCEPTION 'Reserva encerrada não muda.' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.id <> OLD.id OR NEW.empresa_id <> OLD.empresa_id OR NEW.capacidade <> OLD.capacidade
     OR NEW.tokens_reservados <> OLD.tokens_reservados
     OR NEW.custo_reservado_micros IS DISTINCT FROM OLD.custo_reservado_micros
     OR NEW.moeda IS DISTINCT FROM OLD.moeda OR NEW.criado_em <> OLD.criado_em
     OR NEW.periodo_dia <> OLD.periodo_dia OR NEW.periodo_mes <> OLD.periodo_mes THEN
    RAISE EXCEPTION 'Reserva é imutável; só o estado é encerrado.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ia_orcamento_reservas_055a_guarda_trg BEFORE UPDATE OR DELETE ON ia_orcamento_reservas
  FOR EACH ROW EXECUTE FUNCTION kidmais_055a_reserva_guarda();

CREATE TABLE ia_uso_modelo (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  empresa_id uuid NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  estabelecimento_id uuid,
  correlation_id varchar(100) NOT NULL,
  capacidade varchar(64) NOT NULL,
  workload varchar(40) NOT NULL,
  tier varchar(10) NOT NULL CHECK (tier IN ('ECONOMY', 'STANDARD', 'ADVANCED')),
  provedor varchar(16) NOT NULL CHECK (provedor IN ('OPENAI', 'DEEPSEEK')),
  modelo varchar(120) NOT NULL,
  tokens_entrada integer CHECK (tokens_entrada IS NULL OR tokens_entrada >= 0),
  tokens_saida integer CHECK (tokens_saida IS NULL OR tokens_saida >= 0),
  tokens_cache integer CHECK (tokens_cache IS NULL OR tokens_cache >= 0),
  duracao_ms integer NOT NULL CHECK (duracao_ms >= 0),
  custo_estimado_micros bigint CHECK (custo_estimado_micros IS NULL OR custo_estimado_micros >= 0),
  moeda char(3) CHECK (moeda IS NULL OR moeda ~ '^[A-Z]{3}$'),
  sucesso boolean NOT NULL,
  erro varchar(24),
  fallback boolean NOT NULL,
  criado_em timestamptz NOT NULL,
  reserva_id uuid UNIQUE REFERENCES ia_orcamento_reservas(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  -- Período contábil: o da reserva (reconciliação) ou o dia de criado_em em São Paulo (sem reserva).
  periodo_dia date NOT NULL,
  periodo_mes char(7) NOT NULL,
  CONSTRAINT ia_uso_modelo_custo_moeda_check CHECK ((custo_estimado_micros IS NULL) = (moeda IS NULL)),
  -- Uso desconhecido é os dois NULL; nunca um conhecido e o outro não.
  CONSTRAINT ia_uso_modelo_tokens_check CHECK ((tokens_entrada IS NULL) = (tokens_saida IS NULL)),
  CONSTRAINT ia_uso_modelo_custo_conhecido_check CHECK (custo_estimado_micros IS NULL OR tokens_entrada IS NOT NULL),
  CONSTRAINT ia_uso_modelo_periodo_check CHECK (periodo_mes = to_char(periodo_dia, 'YYYY-MM'))
);
CREATE INDEX ia_uso_modelo_empresa_dia_idx ON ia_uso_modelo (empresa_id, periodo_dia);
CREATE INDEX ia_uso_modelo_empresa_mes_idx ON ia_uso_modelo (empresa_id, periodo_mes);
CREATE INDEX ia_uso_modelo_empresa_capacidade_idx ON ia_uso_modelo (empresa_id, capacidade, periodo_dia);
CREATE TRIGGER ia_uso_modelo_055_imutavel_trg BEFORE UPDATE OR DELETE ON ia_uso_modelo
  FOR EACH ROW EXECUTE FUNCTION kidmais_055_somente_insercao();

-- Observabilidade (somente leitura, sem PII). Dia = período contábil (o mesmo do orçamento). Custo
-- agrupado por moeda: moedas diferentes nunca se somam.
CREATE VIEW ia_uso_diario AS
SELECT empresa_id,
       periodo_dia AS dia,
       provedor, modelo, capacidade, workload, tier, moeda,
       count(*) AS chamadas,
       count(*) FILTER (WHERE sucesso) AS sucessos,
       count(*) FILTER (WHERE NOT sucesso) AS erros,
       count(*) FILTER (WHERE fallback) AS fallbacks,
       count(*) FILTER (WHERE tokens_entrada IS NULL) AS chamadas_uso_desconhecido,
       sum(tokens_entrada) AS tokens_entrada,
       sum(tokens_saida) AS tokens_saida,
       sum(custo_estimado_micros) AS custo_estimado_micros,
       count(*) FILTER (WHERE sucesso AND custo_estimado_micros IS NULL) AS chamadas_sem_preco,
       round(avg(duracao_ms)) AS latencia_media_ms,
       percentile_disc(0.95) WITHIN GROUP (ORDER BY duracao_ms) AS latencia_p95_ms
  FROM ia_uso_modelo
 GROUP BY 1, 2, 3, 4, 5, 6, 7, 8;

COMMIT;
