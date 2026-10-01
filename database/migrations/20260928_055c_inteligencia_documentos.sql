-- 055c — Kidmais Intelligence (DOCUMENT): Document Foundation.
--
-- NÃO APLICADA. Exige autorização explícita (docs/OPERACAO_AGENTES.md). Depende da 055a
-- (função compartilhada kidmais_055_somente_insercao). Sem ela o upload responde "indisponível".
--
-- Todas com empresa_id obrigatório; filhos presos à empresa do pai por FK composta.
--   ia_documentos            documento histórico enviado (Document)
--   ia_documento_originais   bytes originais, privados e imutáveis (DocumentVersion / immutable source)
--   ia_extracoes             execuções de extração (ExtractionRun, append-only)
--   ia_evidencias            evidência por campo: página e trecho curto (Evidence, append-only)
BEGIN;

DO $$ BEGIN
  IF to_regclass('public.empresas') IS NULL OR to_regclass('public.usuarios_administrativos') IS NULL THEN
    RAISE EXCEPTION '055c exige empresas e usuarios_administrativos.';
  END IF;
  IF to_regprocedure('public.kidmais_055_somente_insercao()') IS NULL THEN
    RAISE EXCEPTION '055c exige a 055a (kidmais_055_somente_insercao).';
  END IF;
  IF to_regclass('public.ia_documentos') IS NOT NULL THEN
    RAISE EXCEPTION '055c já aplicada (ia_documentos existe).';
  END IF;
END $$;

CREATE TABLE ia_documentos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  tipo varchar(32) NOT NULL CHECK (tipo IN ('CONTRATO_HISTORICO')),
  -- RECEBIDO → resultado da primeira extração (EXTRAIDO, PRECISA_REVISAO ou FALHOU), que é final.
  status varchar(24) NOT NULL CHECK (status IN ('RECEBIDO', 'EXTRAIDO', 'PRECISA_REVISAO', 'FALHOU')),
  enviado_por uuid NOT NULL REFERENCES usuarios_administrativos(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  enviado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ia_documentos_empresa_uk UNIQUE (id, empresa_id)
);
CREATE INDEX ia_documentos_empresa_idx ON ia_documentos (empresa_id, enviado_em DESC);

CREATE FUNCTION kidmais_055_documento_guarda() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ia_documentos não é apagado.' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.id <> OLD.id OR NEW.empresa_id <> OLD.empresa_id OR NEW.enviado_por <> OLD.enviado_por OR NEW.enviado_em <> OLD.enviado_em THEN
    RAISE EXCEPTION 'Identidade do documento é imutável.' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status <> 'RECEBIDO' AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'Estado final do documento não muda.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ia_documentos_055_guarda_trg BEFORE UPDATE OR DELETE ON ia_documentos
  FOR EACH ROW EXECUTE FUNCTION kidmais_055_documento_guarda();

-- Bytes originais: privados (bytea, sem URL pública), imutáveis, com hash conferido pelo banco.
CREATE TABLE ia_documento_originais (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  documento_id uuid NOT NULL,
  empresa_id uuid NOT NULL,
  versao integer NOT NULL CHECK (versao > 0),
  nome_original varchar(200) NOT NULL CHECK (btrim(nome_original) <> '' AND nome_original !~ '[/\\]'),
  content_type varchar(40) NOT NULL CHECK (content_type IN ('application/pdf', 'image/jpeg', 'image/png')),
  tamanho_bytes bigint NOT NULL,
  sha256 char(64) NOT NULL,
  conteudo bytea NOT NULL,
  enviado_por uuid NOT NULL REFERENCES usuarios_administrativos(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  enviado_em timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ia_documento_originais_documento_fk FOREIGN KEY (documento_id, empresa_id)
    REFERENCES ia_documentos (id, empresa_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT ia_documento_originais_versao_uk UNIQUE (documento_id, versao),
  CONSTRAINT ia_documento_originais_empresa_uk UNIQUE (id, empresa_id),
  CONSTRAINT ia_documento_originais_documento_uk UNIQUE (id, documento_id, empresa_id),
  -- O mesmo arquivo enviado de novo na mesma empresa reaproveita o documento (upload idempotente).
  CONSTRAINT ia_documento_originais_hash_uk UNIQUE (empresa_id, sha256),
  CONSTRAINT ia_documento_originais_tamanho_check CHECK (tamanho_bytes > 0 AND tamanho_bytes <= 26214400 AND tamanho_bytes = octet_length(conteudo)),
  CONSTRAINT ia_documento_originais_hash_check CHECK (sha256 ~ '^[0-9a-f]{64}$' AND sha256 = encode(sha256(conteudo), 'hex'))
);
CREATE TRIGGER ia_documento_originais_055_imutavel_trg BEFORE UPDATE OR DELETE ON ia_documento_originais
  FOR EACH ROW EXECUTE FUNCTION kidmais_055_somente_insercao();

CREATE TABLE ia_extracoes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  documento_id uuid NOT NULL,
  empresa_id uuid NOT NULL,
  original_id uuid NOT NULL,
  metodo varchar(24) NOT NULL CHECK (metodo IN ('TEXTO_NATIVO', 'VISAO', 'OCR', 'DETERMINISTICO')),
  provedor varchar(16) CHECK (provedor IS NULL OR provedor IN ('OPENAI', 'DEEPSEEK')),
  modelo varchar(120),
  schema_versao integer NOT NULL CHECK (schema_versao > 0),
  status varchar(16) NOT NULL CHECK (status IN ('SUCESSO', 'PARCIAL', 'FALHOU')),
  resultado jsonb CHECK (resultado IS NULL OR jsonb_typeof(resultado) = 'object'),
  erro varchar(40),
  correlation_id varchar(100) NOT NULL,
  iniciado_em timestamptz NOT NULL,
  concluido_em timestamptz NOT NULL,
  CONSTRAINT ia_extracoes_documento_fk FOREIGN KEY (documento_id, empresa_id)
    REFERENCES ia_documentos (id, empresa_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  -- O original extraído é do mesmo documento (e da mesma empresa).
  CONSTRAINT ia_extracoes_original_fk FOREIGN KEY (original_id, documento_id, empresa_id)
    REFERENCES ia_documento_originais (id, documento_id, empresa_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT ia_extracoes_empresa_uk UNIQUE (id, empresa_id),
  CONSTRAINT ia_extracoes_documento_uk UNIQUE (id, documento_id, empresa_id),
  CONSTRAINT ia_extracoes_modelo_check CHECK ((provedor IS NULL) = (modelo IS NULL)),
  CONSTRAINT ia_extracoes_tempo_check CHECK (concluido_em >= iniciado_em)
);
CREATE INDEX ia_extracoes_documento_idx ON ia_extracoes (documento_id, concluido_em DESC);
CREATE TRIGGER ia_extracoes_055_imutavel_trg BEFORE UPDATE OR DELETE ON ia_extracoes
  FOR EACH ROW EXECUTE FUNCTION kidmais_055_somente_insercao();

CREATE TABLE ia_evidencias (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  extracao_id uuid NOT NULL,
  empresa_id uuid NOT NULL,
  campo varchar(80) NOT NULL CHECK (campo ~ '^[a-z][a-zA-Z0-9_.]{0,79}$'),
  pagina integer CHECK (pagina IS NULL OR pagina > 0),
  trecho varchar(300) NOT NULL,
  conferida boolean NOT NULL,
  CONSTRAINT ia_evidencias_extracao_fk FOREIGN KEY (extracao_id, empresa_id)
    REFERENCES ia_extracoes (id, empresa_id) ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX ia_evidencias_extracao_idx ON ia_evidencias (extracao_id);
CREATE TRIGGER ia_evidencias_055_imutavel_trg BEFORE UPDATE OR DELETE ON ia_evidencias
  FOR EACH ROW EXECUTE FUNCTION kidmais_055_somente_insercao();

COMMIT;
