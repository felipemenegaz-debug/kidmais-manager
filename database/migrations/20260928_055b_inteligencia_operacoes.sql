-- 055b — Kidmais Intelligence (ACTIONS): registro do Human Gate.
--
-- NÃO APLICADA. Exige autorização explícita (docs/OPERACAO_AGENTES.md). Sem ela nenhuma ação CONFIRM
-- é oferecida (fail closed): a rota confere `to_regclass('public.ia_operacoes')`.
--
--   ia_operacoes   rascunhos/confirmações do Human Gate (idempotência por id; estado terminal imutável)
BEGIN;

DO $$ BEGIN
  IF to_regclass('public.empresas') IS NULL OR to_regclass('public.usuarios_administrativos') IS NULL THEN
    RAISE EXCEPTION '055b exige empresas e usuarios_administrativos.';
  END IF;
  IF to_regclass('public.ia_operacoes') IS NOT NULL THEN
    RAISE EXCEPTION '055b já aplicada (ia_operacoes existe).';
  END IF;
END $$;

CREATE TABLE ia_operacoes (
  id uuid PRIMARY KEY,
  empresa_id uuid NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  usuario_id uuid NOT NULL REFERENCES usuarios_administrativos(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  correlation_id varchar(100) NOT NULL CHECK (btrim(correlation_id) <> ''),
  idempotency_key uuid NOT NULL,
  capacidade varchar(64) NOT NULL CHECK (capacidade ~ '^[a-z_]{1,64}$'),
  ferramenta varchar(80) NOT NULL CHECK (ferramenta ~ '^[a-z_.]{1,80}$'),
  estado varchar(24) NOT NULL,
  versao integer NOT NULL CHECK (versao > 0),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  payload_hash varchar(64) NOT NULL CHECK (payload_hash = '' OR payload_hash ~ '^[0-9a-f]{64}$'),
  resultado jsonb CHECK (resultado IS NULL OR jsonb_typeof(resultado) = 'object'),
  expira_em timestamptz NOT NULL,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ia_operacoes_estado_check CHECK (estado IN ('COLETANDO', 'AGUARDANDO_CONFIRMACAO', 'EXECUTADA', 'CANCELADA', 'EXPIRADA', 'FALHOU')),
  CONSTRAINT ia_operacoes_idempotencia_uk UNIQUE (idempotency_key),
  CONSTRAINT ia_operacoes_confirmavel_check CHECK (estado <> 'AGUARDANDO_CONFIRMACAO' OR payload_hash <> ''),
  CONSTRAINT ia_operacoes_executada_check CHECK (estado <> 'EXECUTADA' OR resultado IS NOT NULL)
);
CREATE INDEX ia_operacoes_empresa_usuario_idx ON ia_operacoes (empresa_id, usuario_id, criado_em DESC);

CREATE FUNCTION kidmais_055_operacao_guarda() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ia_operacoes não é apagada: é o registro do Human Gate.' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.id <> OLD.id OR NEW.empresa_id <> OLD.empresa_id OR NEW.usuario_id <> OLD.usuario_id
     OR NEW.capacidade <> OLD.capacidade OR NEW.ferramenta <> OLD.ferramenta
     OR NEW.idempotency_key <> OLD.idempotency_key OR NEW.criado_em <> OLD.criado_em THEN
    RAISE EXCEPTION 'Identidade da operação é imutável.' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.estado IN ('EXECUTADA', 'CANCELADA', 'EXPIRADA', 'FALHOU') THEN
    RAISE EXCEPTION 'Operação encerrada não muda.' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.versao < OLD.versao THEN
    RAISE EXCEPTION 'Versão da operação não retrocede.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ia_operacoes_055_guarda_trg BEFORE UPDATE OR DELETE ON ia_operacoes
  FOR EACH ROW EXECUTE FUNCTION kidmais_055_operacao_guarda();

-- Human Gate: rascunhos, confirmações e cancelamentos por empresa/capacidade/dia (sem PII).
CREATE VIEW ia_operacoes_resumo AS
SELECT empresa_id,
       (criado_em AT TIME ZONE 'America/Sao_Paulo')::date AS dia,
       capacidade,
       count(*) AS rascunhos,
       count(*) FILTER (WHERE estado = 'EXECUTADA') AS confirmadas,
       count(*) FILTER (WHERE estado = 'CANCELADA') AS canceladas,
       count(*) FILTER (WHERE estado IN ('COLETANDO', 'AGUARDANDO_CONFIRMACAO') AND expira_em <= now()) AS expiradas
  FROM ia_operacoes
 GROUP BY 1, 2, 3;

COMMIT;
