-- 069 — Cadastro público (E6): verificação de e-mail ANTES de criar a conta, aceite versionado de termos e privacidade,
-- criação idempotente da empresa pelo cadastro, sócios declarados e pedidos de acesso a CNPJ já cadastrado.
--
-- NÃO APLICADA. Exige 063, 067 e 068, e autorização explícita (docs/OPERACAO_AGENTES.md) para qualquer banco.
--
--   1. cadastros_publicos: pedido de conta pendente de confirmação do e-mail. A conta (usuarios_administrativos) só nasce
--      quando o link de uso único é aberto. Só o hash do token fica no banco; o hash da senha (scrypt) fica aqui até a
--      confirmação e é apagado nela. Um pedido pendente por e-mail.
--   2. aceites_documentos_legais: quem aceitou qual versão (e hash do texto) dos termos e da privacidade, quando e de
--      onde. Só inserção.
--   3. cadastros_empresas: chave de idempotência da criação de empresa pelo cadastro (repetir o envio devolve a mesma
--      empresa).
--   4. empresa_socios: sócios/administradores DECLARADOS por quem cadastrou (só nome e qualificação; sem documento).
--      Declaração não é certificação: a representação legal fica em empresa_representacoes (067) e depende de decisão.
--   5. solicitacoes_acesso_empresa: CNPJ já cadastrado vira pedido de acesso, sem revelar nada da empresa existente.
-- Nenhuma linha existente é criada ou alterada.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = public, pg_catalog;

DO $$ BEGIN
  IF to_regclass('public.cobranca_eventos') IS NULL THEN RAISE EXCEPTION '069 exige a 068.'; END IF;
  IF to_regclass('public.plataforma_empresas_cadastro') IS NULL THEN RAISE EXCEPTION '069 exige a 063.'; END IF;
  IF to_regclass('public.cadastros_publicos') IS NOT NULL THEN RAISE EXCEPTION '069 já aplicada.'; END IF;
END $$;

CREATE FUNCTION kidmais_069_somente_insercao() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION '069: % só aceita inserção.', TG_TABLE_NAME USING ERRCODE = 'P0001';
END $$;

-- 1. Pedido de conta ---------------------------------------------------------------------------------------------------
CREATE TABLE cadastros_publicos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  nome text NOT NULL,
  senha_hash text,
  token_hash char(64) NOT NULL,
  situacao text NOT NULL DEFAULT 'PENDENTE',
  expira_em timestamptz NOT NULL,
  envios integer NOT NULL DEFAULT 0,
  ultimo_envio_em timestamptz,
  termos_versao text NOT NULL,
  termos_hash char(64) NOT NULL,
  privacidade_versao text NOT NULL,
  privacidade_hash char(64) NOT NULL,
  usuario_id uuid REFERENCES usuarios_administrativos (id),
  confirmado_em timestamptz,
  criado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT cadastros_publicos_email_check CHECK (email = lower(btrim(email)) AND length(email) <= 254 AND email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  CONSTRAINT cadastros_publicos_nome_check CHECK (nome = btrim(nome) AND char_length(nome) BETWEEN 2 AND 120),
  CONSTRAINT cadastros_publicos_token_check CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT cadastros_publicos_situacao_check CHECK (situacao IN ('PENDENTE', 'CONFIRMADO', 'SUBSTITUIDO')),
  -- A senha só existe enquanto pendente; confirmado tem conta e data; substituído não tem nenhum dos dois.
  CONSTRAINT cadastros_publicos_estado_check CHECK (
    (situacao = 'PENDENTE' AND senha_hash IS NOT NULL AND senha_hash LIKE 'scrypt$%' AND usuario_id IS NULL AND confirmado_em IS NULL)
    OR (situacao = 'CONFIRMADO' AND senha_hash IS NULL AND usuario_id IS NOT NULL AND confirmado_em IS NOT NULL)
    OR (situacao = 'SUBSTITUIDO' AND senha_hash IS NULL AND usuario_id IS NULL AND confirmado_em IS NULL)),
  CONSTRAINT cadastros_publicos_versoes_check CHECK (termos_versao ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}(-[a-z0-9]+)?$' AND privacidade_versao ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}(-[a-z0-9]+)?$'
    AND termos_hash ~ '^[0-9a-f]{64}$' AND privacidade_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT cadastros_publicos_envios_check CHECK (envios >= 0),
  CONSTRAINT cadastros_publicos_prazo_check CHECK (expira_em > criado_em AND expira_em <= criado_em + interval '7 days'),
  CONSTRAINT cadastros_publicos_token_uk UNIQUE (token_hash)
);
CREATE UNIQUE INDEX cadastros_publicos_pendente_uk ON cadastros_publicos (email) WHERE situacao = 'PENDENTE';

CREATE FUNCTION kidmais_069_cadastro_guarda() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Pedido de cadastro não é apagado.' USING ERRCODE = 'P0001'; END IF;
  IF NEW.id <> OLD.id OR NEW.email <> OLD.email OR NEW.criado_em <> OLD.criado_em OR NEW.termos_versao <> OLD.termos_versao
     OR NEW.termos_hash <> OLD.termos_hash OR NEW.privacidade_versao <> OLD.privacidade_versao OR NEW.privacidade_hash <> OLD.privacidade_hash THEN
    RAISE EXCEPTION 'Pedido de cadastro: identidade imutável.' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.situacao <> 'PENDENTE' THEN RAISE EXCEPTION 'Pedido de cadastro já encerrado.' USING ERRCODE = 'P0001'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cadastros_publicos_069_guarda_trg BEFORE UPDATE OR DELETE ON cadastros_publicos
  FOR EACH ROW EXECUTE FUNCTION kidmais_069_cadastro_guarda();

-- 2. Aceites -----------------------------------------------------------------------------------------------------------
CREATE TABLE aceites_documentos_legais (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id uuid NOT NULL REFERENCES usuarios_administrativos (id),
  empresa_id uuid REFERENCES empresas (id),
  documento text NOT NULL,
  versao text NOT NULL,
  hash_conteudo char(64) NOT NULL,
  origem text NOT NULL,
  aceito_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  ip inet,
  user_agent text,
  CONSTRAINT aceites_documento_check CHECK (documento IN ('TERMOS_USO', 'PRIVACIDADE')),
  CONSTRAINT aceites_versao_check CHECK (versao ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}(-[a-z0-9]+)?$' AND hash_conteudo ~ '^[0-9a-f]{64}$'),
  CONSTRAINT aceites_origem_check CHECK (origem IN ('CADASTRO', 'NOVA_EMPRESA')),
  CONSTRAINT aceites_user_agent_check CHECK (user_agent IS NULL OR char_length(user_agent) <= 1000)
);
CREATE INDEX aceites_usuario_idx ON aceites_documentos_legais (usuario_id, aceito_em DESC);
CREATE TRIGGER aceites_069_somente_insercao_trg BEFORE UPDATE OR DELETE ON aceites_documentos_legais
  FOR EACH ROW EXECUTE FUNCTION kidmais_069_somente_insercao();

-- 3. Idempotência da criação de empresa --------------------------------------------------------------------------------
CREATE TABLE cadastros_empresas (
  usuario_id uuid NOT NULL REFERENCES usuarios_administrativos (id),
  chave uuid NOT NULL,
  empresa_id uuid NOT NULL REFERENCES empresas (id),
  documento text NOT NULL,
  criado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (usuario_id, chave),
  CONSTRAINT cadastros_empresas_documento_check CHECK (documento ~ '^[0-9A-Z]{12}[0-9]{2}$'),
  CONSTRAINT cadastros_empresas_empresa_uk UNIQUE (empresa_id)
);
CREATE TRIGGER cadastros_empresas_069_somente_insercao_trg BEFORE UPDATE OR DELETE ON cadastros_empresas
  FOR EACH ROW EXECUTE FUNCTION kidmais_069_somente_insercao();

-- 4. Sócios declarados -------------------------------------------------------------------------------------------------
CREATE TABLE empresa_socios (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresas (id),
  nome text NOT NULL,
  qualificacao text NOT NULL,
  fonte text NOT NULL DEFAULT 'DECLARADO',
  declarado_por uuid NOT NULL REFERENCES usuarios_administrativos (id),
  criado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT empresa_socios_nome_check CHECK (nome = btrim(nome) AND char_length(nome) BETWEEN 2 AND 160),
  CONSTRAINT empresa_socios_qualificacao_check CHECK (qualificacao IN ('SOCIO', 'ADMINISTRADOR', 'SOCIO_ADMINISTRADOR')),
  CONSTRAINT empresa_socios_fonte_check CHECK (fonte IN ('DECLARADO'))
);
CREATE INDEX empresa_socios_empresa_idx ON empresa_socios (empresa_id);
CREATE TRIGGER empresa_socios_069_somente_insercao_trg BEFORE UPDATE OR DELETE ON empresa_socios
  FOR EACH ROW EXECUTE FUNCTION kidmais_069_somente_insercao();

-- 5. Pedidos de acesso a CNPJ já cadastrado ----------------------------------------------------------------------------
CREATE TABLE solicitacoes_acesso_empresa (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id uuid NOT NULL REFERENCES usuarios_administrativos (id),
  documento text NOT NULL,
  empresa_id uuid REFERENCES empresas (id),
  situacao text NOT NULL DEFAULT 'PENDENTE',
  criado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  decidido_em timestamptz,
  decidido_por uuid REFERENCES usuarios_administrativos (id),
  motivo_decisao text,
  CONSTRAINT solicitacoes_documento_check CHECK (documento ~ '^[0-9A-Z]{12}[0-9]{2}$'),
  CONSTRAINT solicitacoes_situacao_check CHECK (situacao IN ('PENDENTE', 'ATENDIDA', 'RECUSADA')),
  CONSTRAINT solicitacoes_decisao_check CHECK ((situacao = 'PENDENTE') = (decidido_em IS NULL AND decidido_por IS NULL)
    AND (situacao = 'PENDENTE' OR char_length(btrim(coalesce(motivo_decisao, ''))) BETWEEN 3 AND 500))
);
CREATE UNIQUE INDEX solicitacoes_pendente_uk ON solicitacoes_acesso_empresa (usuario_id, documento) WHERE situacao = 'PENDENTE';
CREATE INDEX solicitacoes_empresa_idx ON solicitacoes_acesso_empresa (empresa_id, criado_em DESC) WHERE empresa_id IS NOT NULL;

COMMENT ON TABLE cadastros_publicos IS '069: pedido de conta; a conta nasce só na confirmação do e-mail.';
COMMENT ON TABLE aceites_documentos_legais IS '069: aceite versionado de termos e privacidade (só inserção).';
COMMENT ON TABLE empresa_socios IS '069: sócios declarados no cadastro; declaração não certifica representação.';
COMMENT ON TABLE solicitacoes_acesso_empresa IS '069: pedido de acesso quando o CNPJ já está cadastrado; nada da empresa é revelado.';

COMMIT;
