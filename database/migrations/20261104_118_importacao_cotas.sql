-- 118 — Cota de leitura de documentos da importação de contratos (L2 do plano "Importação de contratos em lote 20261031",
-- rev. 5.1 + delta D-LOTE-8 rev. 6.1, ambos APROVADOS pelo Astra em 31/10/2026; D-LOTE-6/8 decididas por Felipe).
-- LOCAL, preparada em 04/11/2026. NÃO aplicada em staging/produção. Exige 055c (ia_documentos).
-- Só acréscimos; nenhuma linha existente é alterada. Duas tabelas isoladas, lidas só pela cota:
--   ia_importacao_cotas: uma linha de trava por empresa (criada sob demanda) e o marco da janela de migração
--     (migracao_inicio: gravado uma única vez, na primeira leitura com dados e plano confirmado; nunca regravado);
--   ia_importacao_usos: um uso por arquivo (empresa + sha256) e por posse (operacao_id). Estados RESERVADA → CONSUMIDA |
--     LIBERADA; no máximo uma linha viva (RESERVADA ou CONSUMIDA) por arquivo da empresa.
-- As regras de tempo (vigência, período, janela) usam o instante T lido com clock_timestamp() DEPOIS da trava da empresa
-- (R3-1); as duas funções abaixo só fixam a fronteira exata para que código e testes usem a mesma definição.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;

DO $$ BEGIN
  IF to_regclass('public.empresas') IS NULL OR to_regclass('public.ia_documentos') IS NULL THEN
    RAISE EXCEPTION '118 exige empresas e a 055c (ia_documentos).';
  END IF;
  IF to_regclass('public.ia_importacao_cotas') IS NOT NULL OR to_regclass('public.ia_importacao_usos') IS NOT NULL
     OR to_regprocedure('public.kidmais_118_janela_migracao(timestamptz,timestamptz)') IS NOT NULL
     OR to_regprocedure('public.kidmais_118_periodo_mensal(timestamptz)') IS NOT NULL
     OR to_regprocedure('public.kidmais_118_guarda()') IS NOT NULL THEN
    RAISE EXCEPTION '118 já (parcialmente) presente.';
  END IF;
END $$;

-- Janela de migração: aberta antes do marco (NULL) e em [inicio, inicio + 30 dias). 30 dias = 720 horas, independente do
-- fuso da sessão. Em T = inicio + 30 dias já vale a regra normal.
CREATE FUNCTION kidmais_118_janela_migracao(inicio timestamptz, t timestamptz) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog, pg_temp
  AS $$ SELECT inicio IS NULL OR (t >= inicio AND t < inicio + interval '720 hours') $$;

-- Período mensal: mês civil de São Paulo do instante T.
CREATE FUNCTION kidmais_118_periodo_mensal(t timestamptz) RETURNS text
  LANGUAGE sql STABLE PARALLEL SAFE SET search_path = pg_catalog, pg_temp
  AS $$ SELECT to_char(t AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM') $$;

CREATE TABLE ia_importacao_cotas (
  empresa_id uuid PRIMARY KEY REFERENCES empresas(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  migracao_inicio timestamptz,
  criado_em timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE ia_importacao_usos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES ia_importacao_cotas(empresa_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  sha256 char(64) NOT NULL,
  documento_id uuid NOT NULL,
  operacao_id uuid NOT NULL,
  periodo text NOT NULL,
  estado text NOT NULL,
  expira_em timestamptz NOT NULL,
  criado_em timestamptz NOT NULL,
  atualizado_em timestamptz NOT NULL,
  CONSTRAINT ia_importacao_usos_documento_fk FOREIGN KEY (documento_id, empresa_id) REFERENCES ia_documentos(id, empresa_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT ia_importacao_usos_operacao_uk UNIQUE (operacao_id),
  CONSTRAINT ia_importacao_usos_sha256_check CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ia_importacao_usos_periodo_check CHECK (periodo ~ '^([0-9]{4}-(0[1-9]|1[0-2])|IMPLANTACAO|MIGRACAO)$'),
  CONSTRAINT ia_importacao_usos_estado_check CHECK (estado IN ('RESERVADA', 'CONSUMIDA', 'LIBERADA')),
  CONSTRAINT ia_importacao_usos_prazo_check CHECK (expira_em > criado_em AND atualizado_em >= criado_em)
);
-- No máximo uma linha viva por arquivo da empresa: não há reserva compartilhada nem segundo consumo do mesmo arquivo.
CREATE UNIQUE INDEX ia_importacao_usos_vivo_uk ON ia_importacao_usos (empresa_id, sha256) WHERE estado IN ('RESERVADA', 'CONSUMIDA');
CREATE INDEX ia_importacao_usos_periodo_idx ON ia_importacao_usos (empresa_id, periodo) WHERE estado IN ('RESERVADA', 'CONSUMIDA');

-- Guarda: nada é apagado; identidade, período e prazo do uso são imutáveis; RESERVADA só sai para CONSUMIDA ou LIBERADA e
-- estados finais não mudam; o marco da janela de migração é gravado uma vez e nunca muda.
CREATE FUNCTION kidmais_118_guarda() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '% não é apagada (118).', TG_TABLE_NAME USING ERRCODE = 'P0001';
  END IF;
  IF TG_TABLE_NAME = 'ia_importacao_cotas' THEN
    IF NEW.empresa_id <> OLD.empresa_id OR NEW.criado_em <> OLD.criado_em THEN
      RAISE EXCEPTION 'Identidade da cota é imutável (118).' USING ERRCODE = 'P0001';
    END IF;
    IF OLD.migracao_inicio IS NOT NULL AND NEW.migracao_inicio IS DISTINCT FROM OLD.migracao_inicio THEN
      RAISE EXCEPTION 'O início da janela de migração não muda (118).' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.empresa_id <> OLD.empresa_id OR NEW.sha256 <> OLD.sha256 OR NEW.documento_id <> OLD.documento_id
     OR NEW.operacao_id <> OLD.operacao_id OR NEW.periodo <> OLD.periodo OR NEW.expira_em <> OLD.expira_em OR NEW.criado_em <> OLD.criado_em THEN
    RAISE EXCEPTION 'Identidade, período e prazo do uso são imutáveis (118).' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.estado <> 'RESERVADA' OR NEW.estado NOT IN ('CONSUMIDA', 'LIBERADA') THEN
    RAISE EXCEPTION 'Transição de uso inválida: % → % (118).', OLD.estado, NEW.estado USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ia_importacao_cotas_118_guarda BEFORE UPDATE OR DELETE ON ia_importacao_cotas
  FOR EACH ROW EXECUTE FUNCTION kidmais_118_guarda();
CREATE TRIGGER ia_importacao_usos_118_guarda BEFORE UPDATE OR DELETE ON ia_importacao_usos
  FOR EACH ROW EXECUTE FUNCTION kidmais_118_guarda();

COMMIT;
