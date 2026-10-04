-- 063 — Painel do desenvolvedor: concessão de plataforma, interessadas, contratantes, convites, recuperação de senha
--        e reativação controlada de empresa e de vínculo.
--
-- NÃO APLICADA. Exige autorização explícita (docs/OPERACAO_AGENTES.md) para qualquer banco, inclusive staging,
-- clones e o cluster descartável. Proposta e decisões em docs/PAINEL_DESENVOLVEDOR.md.
--
-- 1. plataforma_desenvolvedores: quem acessa o painel. Separada do papel global e do papel de empresa: ser Gestão
--    (proprietário) de qualquer empresa não concede o painel. Concedida e revogada só fora da aplicação
--    (scripts/admin-provision.cjs desenvolvedor). Linha nunca apagada; revogação uma vez; nova concessão = nova linha.
-- 2. plataforma_interessadas: registro comercial. Não cria empresa, usuário nem acesso. CONVERTIDA é terminal e só
--    com a empresa provisionada.
-- 3. plataforma_empresas_cadastro: dados administrativos da contratante e acompanhamento da implantação, fora de
--    `empresas` (cujo ciclo continua no guard).
-- 4. convites_acesso: convite de acesso a UMA empresa. Só o hash do token é guardado. "Expirado" é derivado de expira_em.
-- 5. recuperacoes_senha: token de uso único com expiração; no máximo um pedido aberto por usuário.
-- 6. Ciclo da empresa (substitui o guard da 044): acrescenta SUSPENSA → ATIVA (reativação). Demais regras idênticas.
-- 7. Ciclo da membership (substitui o guard da 045): status novo SUSPENSA (vínculo desativado, reversível):
--    ATIVA → SUSPENSA, SUSPENSA → ATIVA, SUSPENSA → REVOGADA. Demais regras idênticas; REVOGADA continua terminal.
--    provarTenant só aceita ATIVA, então SUSPENSA não dá acesso a nada.
-- As funções da 044 e da 045 permanecem para o rollback reapontar os gatilhos.
-- Nenhuma linha existente é alterada. Nenhuma concessão de desenvolvedor é criada aqui.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = public, pg_catalog;

DO $$ BEGIN
  IF to_regclass('public.plataforma_desenvolvedores') IS NOT NULL THEN RAISE EXCEPTION '063 já aplicada.'; END IF;
  IF to_regclass('public.empresa_membership_capacidades') IS NULL THEN RAISE EXCEPTION '063 exige a 057 aplicada antes.'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'memberships' AND column_name = 'papel') THEN
    RAISE EXCEPTION '063 exige a 056 (memberships.papel).';
  END IF;
  IF to_regclass('public.limites_autenticacao') IS NULL OR to_regclass('public.sessoes_administrativas') IS NULL THEN
    RAISE EXCEPTION '063 exige a 013 (autenticação administrativa).';
  END IF;
  IF (SELECT tgfoid FROM pg_trigger WHERE tgrelid = 'public.empresas'::regclass AND tgname = 'empresas_guard_trg') IS DISTINCT FROM 'public.kidmais_044_guard_empresas()'::regprocedure
     OR (SELECT tgfoid FROM pg_trigger WHERE tgrelid = 'public.memberships'::regclass AND tgname = 'kidmais_043_memberships_guard_trg') IS DISTINCT FROM 'public.kidmais_045_guard_memberships()'::regprocedure THEN
    RAISE EXCEPTION '063: gatilhos de empresa/membership não apontam para a 044/045.';
  END IF;
  IF (SELECT encode(sha256(convert_to(replace(prosrc, E'\r', ''), 'UTF8')), 'hex') FROM pg_proc WHERE oid = 'public.kidmais_044_guard_empresas()'::regprocedure) IS DISTINCT FROM 'c02a8c59927e4ece125273049d5185b60e0011cbac3e0dd456e182a0dcc78054'
     OR (SELECT encode(sha256(convert_to(replace(prosrc, E'\r', ''), 'UTF8')), 'hex') FROM pg_proc WHERE oid = 'public.kidmais_045_guard_memberships()'::regprocedure) IS DISTINCT FROM 'c47fb4bfe261d86042763748b28e1fae4d3b703cfebee37d1411ad61eef5fa60' THEN
    RAISE EXCEPTION '063: corpos dos guards da 044/045 divergem.';
  END IF;
  IF to_regprocedure('public.kidmais_063_guard_empresas()') IS NOT NULL OR to_regprocedure('public.kidmais_063_guard_memberships()') IS NOT NULL THEN
    RAISE EXCEPTION '063: funções da 063 já existem.';
  END IF;
END $$;

-- Proteção comum: nada destas tabelas é apagado nem truncado.
CREATE FUNCTION kidmais_063_sem_exclusao()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $f$
BEGIN
  RAISE EXCEPTION '063: exclusão física recusada em %.', TG_TABLE_NAME;
END;
$f$;

-- 1. Concessão de desenvolvedor ------------------------------------------------------------------------------------
CREATE TABLE plataforma_desenvolvedores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id uuid NOT NULL,
  concedido_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  concedido_por text NOT NULL,
  motivo text NOT NULL,
  revogado_em timestamptz,
  revogado_por text,
  motivo_revogacao text,
  CONSTRAINT kidmais_063_dev_usuario_fk FOREIGN KEY (usuario_id) REFERENCES usuarios_administrativos (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT kidmais_063_dev_concedido_por_ck CHECK (length(btrim(concedido_por)) BETWEEN 1 AND 120),
  CONSTRAINT kidmais_063_dev_motivo_ck CHECK (length(btrim(motivo)) BETWEEN 3 AND 500),
  CONSTRAINT kidmais_063_dev_revogacao_ck CHECK (
    (revogado_em IS NULL AND revogado_por IS NULL AND motivo_revogacao IS NULL)
    OR (revogado_em IS NOT NULL AND revogado_em >= concedido_em
        AND length(btrim(revogado_por)) BETWEEN 1 AND 120 AND length(btrim(motivo_revogacao)) BETWEEN 3 AND 500)
  )
);
CREATE UNIQUE INDEX kidmais_063_dev_ativo_uk ON plataforma_desenvolvedores (usuario_id) WHERE revogado_em IS NULL;

CREATE FUNCTION kidmais_063_guard_desenvolvedores()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $f$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.revogado_em IS NOT NULL THEN RAISE EXCEPTION '063: concessão nova começa ativa.'; END IF;
    NEW.concedido_em := clock_timestamp();
    RETURN NEW;
  END IF;
  IF OLD.revogado_em IS NOT NULL THEN RAISE EXCEPTION '063: concessão revogada é imutável.'; END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.usuario_id IS DISTINCT FROM OLD.usuario_id
     OR NEW.concedido_em IS DISTINCT FROM OLD.concedido_em OR NEW.concedido_por IS DISTINCT FROM OLD.concedido_por
     OR NEW.motivo IS DISTINCT FROM OLD.motivo OR NEW.revogado_em IS NULL THEN
    RAISE EXCEPTION '063: concessão só pode ser revogada.';
  END IF;
  NEW.revogado_em := clock_timestamp();
  RETURN NEW;
END;
$f$;
CREATE TRIGGER kidmais_063_dev_guard_trg BEFORE INSERT OR UPDATE ON plataforma_desenvolvedores
FOR EACH ROW EXECUTE FUNCTION kidmais_063_guard_desenvolvedores();
CREATE TRIGGER kidmais_063_dev_sem_exclusao_trg BEFORE DELETE ON plataforma_desenvolvedores
FOR EACH ROW EXECUTE FUNCTION kidmais_063_sem_exclusao();
CREATE TRIGGER kidmais_063_dev_sem_truncate_trg BEFORE TRUNCATE ON plataforma_desenvolvedores
FOR EACH STATEMENT EXECUTE FUNCTION kidmais_063_sem_exclusao();

-- 2. Interessadas ----------------------------------------------------------------------------------------------------
CREATE TABLE plataforma_interessadas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nome text NOT NULL,
  nome_empresarial text,
  documento_fiscal text,
  responsavel_nome text,
  email text,
  telefone text,
  status text NOT NULL DEFAULT 'NOVA',
  observacoes text,
  empresa_id uuid,
  criado_por uuid NOT NULL,
  atualizado_por uuid NOT NULL,
  criado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  atualizado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  revisao bigint NOT NULL DEFAULT 1,
  CONSTRAINT kidmais_063_int_empresa_fk FOREIGN KEY (empresa_id) REFERENCES empresas (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT kidmais_063_int_criado_por_fk FOREIGN KEY (criado_por) REFERENCES usuarios_administrativos (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT kidmais_063_int_atualizado_por_fk FOREIGN KEY (atualizado_por) REFERENCES usuarios_administrativos (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT kidmais_063_int_nome_ck CHECK (nome = btrim(nome) AND length(nome) BETWEEN 2 AND 160),
  CONSTRAINT kidmais_063_int_nome_empresarial_ck CHECK (nome_empresarial IS NULL OR (nome_empresarial = btrim(nome_empresarial) AND length(nome_empresarial) BETWEEN 2 AND 200)),
  CONSTRAINT kidmais_063_int_documento_ck CHECK (documento_fiscal IS NULL OR documento_fiscal ~ '^([0-9]{11}|[0-9A-Z]{12}[0-9]{2})$'),
  CONSTRAINT kidmais_063_int_responsavel_ck CHECK (responsavel_nome IS NULL OR (responsavel_nome = btrim(responsavel_nome) AND length(responsavel_nome) BETWEEN 2 AND 160)),
  CONSTRAINT kidmais_063_int_email_ck CHECK (email IS NULL OR (email = lower(btrim(email)) AND length(email) <= 254 AND email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')),
  CONSTRAINT kidmais_063_int_telefone_ck CHECK (telefone IS NULL OR telefone ~ '^[0-9]{10,13}$'),
  CONSTRAINT kidmais_063_int_contato_ck CHECK (email IS NOT NULL OR telefone IS NOT NULL),
  CONSTRAINT kidmais_063_int_status_ck CHECK (status IN ('NOVA', 'EM_CONTATO', 'PROPOSTA', 'CONVERTIDA', 'DESCARTADA')),
  CONSTRAINT kidmais_063_int_conversao_ck CHECK ((status = 'CONVERTIDA') = (empresa_id IS NOT NULL)),
  CONSTRAINT kidmais_063_int_observacoes_ck CHECK (observacoes IS NULL OR length(observacoes) <= 4000),
  CONSTRAINT kidmais_063_int_datas_ck CHECK (atualizado_em >= criado_em),
  CONSTRAINT kidmais_063_int_revisao_ck CHECK (revisao > 0)
);
-- Duplicidade: o mesmo documento ou e-mail não aparece em duas interessadas em aberto (descartadas não contam).
CREATE UNIQUE INDEX kidmais_063_int_documento_uk ON plataforma_interessadas (documento_fiscal)
  WHERE documento_fiscal IS NOT NULL AND status <> 'DESCARTADA';
CREATE UNIQUE INDEX kidmais_063_int_email_uk ON plataforma_interessadas (email)
  WHERE email IS NOT NULL AND status <> 'DESCARTADA';
CREATE UNIQUE INDEX kidmais_063_int_empresa_uk ON plataforma_interessadas (empresa_id) WHERE empresa_id IS NOT NULL;
CREATE INDEX kidmais_063_int_status_idx ON plataforma_interessadas (status, atualizado_em DESC);

CREATE FUNCTION kidmais_063_guard_interessadas()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $f$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'CONVERTIDA' OR NEW.empresa_id IS NOT NULL THEN
      RAISE EXCEPTION '063: interessada nova não nasce convertida.';
    END IF;
    NEW.criado_em := clock_timestamp();
    NEW.atualizado_em := NEW.criado_em;
    NEW.revisao := 1;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.criado_por IS DISTINCT FROM OLD.criado_por OR NEW.criado_em IS DISTINCT FROM OLD.criado_em THEN
    RAISE EXCEPTION '063: identidade da interessada é imutável.';
  END IF;
  IF OLD.status = 'CONVERTIDA' THEN
    IF NEW.status IS DISTINCT FROM OLD.status OR NEW.empresa_id IS DISTINCT FROM OLD.empresa_id THEN
      RAISE EXCEPTION '063: interessada convertida não muda de situação nem de empresa.';
    END IF;
  ELSIF NEW.status = 'CONVERTIDA' AND OLD.status = 'DESCARTADA' THEN
    RAISE EXCEPTION '063: interessada descartada precisa ser reaberta antes da conversão.';
  END IF;
  NEW.atualizado_em := clock_timestamp();
  NEW.revisao := OLD.revisao + 1;
  RETURN NEW;
END;
$f$;
CREATE TRIGGER kidmais_063_int_guard_trg BEFORE INSERT OR UPDATE ON plataforma_interessadas
FOR EACH ROW EXECUTE FUNCTION kidmais_063_guard_interessadas();
CREATE TRIGGER kidmais_063_int_sem_exclusao_trg BEFORE DELETE ON plataforma_interessadas
FOR EACH ROW EXECUTE FUNCTION kidmais_063_sem_exclusao();
CREATE TRIGGER kidmais_063_int_sem_truncate_trg BEFORE TRUNCATE ON plataforma_interessadas
FOR EACH STATEMENT EXECUTE FUNCTION kidmais_063_sem_exclusao();

-- 3. Cadastro administrativo da contratante -------------------------------------------------------------------------
CREATE TABLE plataforma_empresas_cadastro (
  empresa_id uuid PRIMARY KEY,
  nome_empresarial text,
  documento_fiscal text,
  responsavel_nome text NOT NULL,
  email text NOT NULL,
  telefone text,
  observacoes text,
  interessada_id uuid,
  implantacao text NOT NULL DEFAULT 'AGUARDANDO_PRIMEIRO_ACESSO',
  implantacao_concluida_em timestamptz,
  criado_por uuid NOT NULL,
  atualizado_por uuid NOT NULL,
  criado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  atualizado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  revisao bigint NOT NULL DEFAULT 1,
  CONSTRAINT kidmais_063_cad_empresa_fk FOREIGN KEY (empresa_id) REFERENCES empresas (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT kidmais_063_cad_interessada_fk FOREIGN KEY (interessada_id) REFERENCES plataforma_interessadas (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT kidmais_063_cad_criado_por_fk FOREIGN KEY (criado_por) REFERENCES usuarios_administrativos (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT kidmais_063_cad_atualizado_por_fk FOREIGN KEY (atualizado_por) REFERENCES usuarios_administrativos (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT kidmais_063_cad_interessada_uk UNIQUE (interessada_id),
  CONSTRAINT kidmais_063_cad_nome_empresarial_ck CHECK (nome_empresarial IS NULL OR (nome_empresarial = btrim(nome_empresarial) AND length(nome_empresarial) BETWEEN 2 AND 200)),
  CONSTRAINT kidmais_063_cad_documento_ck CHECK (documento_fiscal IS NULL OR documento_fiscal ~ '^([0-9]{11}|[0-9A-Z]{12}[0-9]{2})$'),
  CONSTRAINT kidmais_063_cad_responsavel_ck CHECK (responsavel_nome = btrim(responsavel_nome) AND length(responsavel_nome) BETWEEN 2 AND 160),
  CONSTRAINT kidmais_063_cad_email_ck CHECK (email = lower(btrim(email)) AND length(email) <= 254 AND email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  CONSTRAINT kidmais_063_cad_telefone_ck CHECK (telefone IS NULL OR telefone ~ '^[0-9]{10,13}$'),
  CONSTRAINT kidmais_063_cad_observacoes_ck CHECK (observacoes IS NULL OR length(observacoes) <= 4000),
  CONSTRAINT kidmais_063_cad_implantacao_ck CHECK (implantacao IN ('AGUARDANDO_PRIMEIRO_ACESSO', 'EM_CONFIGURACAO', 'CONCLUIDA')),
  CONSTRAINT kidmais_063_cad_conclusao_ck CHECK ((implantacao = 'CONCLUIDA') = (implantacao_concluida_em IS NOT NULL)),
  CONSTRAINT kidmais_063_cad_datas_ck CHECK (atualizado_em >= criado_em),
  CONSTRAINT kidmais_063_cad_revisao_ck CHECK (revisao > 0)
);
CREATE UNIQUE INDEX kidmais_063_cad_documento_uk ON plataforma_empresas_cadastro (documento_fiscal) WHERE documento_fiscal IS NOT NULL;

CREATE FUNCTION kidmais_063_guard_cadastro()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $f$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.criado_em := clock_timestamp();
    NEW.atualizado_em := NEW.criado_em;
    NEW.revisao := 1;
    RETURN NEW;
  END IF;
  IF NEW.empresa_id IS DISTINCT FROM OLD.empresa_id OR NEW.criado_por IS DISTINCT FROM OLD.criado_por
     OR NEW.criado_em IS DISTINCT FROM OLD.criado_em
     OR (OLD.interessada_id IS NOT NULL AND NEW.interessada_id IS DISTINCT FROM OLD.interessada_id) THEN
    RAISE EXCEPTION '063: identidade do cadastro da empresa é imutável.';
  END IF;
  NEW.atualizado_em := clock_timestamp();
  NEW.revisao := OLD.revisao + 1;
  RETURN NEW;
END;
$f$;
CREATE TRIGGER kidmais_063_cad_guard_trg BEFORE INSERT OR UPDATE ON plataforma_empresas_cadastro
FOR EACH ROW EXECUTE FUNCTION kidmais_063_guard_cadastro();
CREATE TRIGGER kidmais_063_cad_sem_exclusao_trg BEFORE DELETE ON plataforma_empresas_cadastro
FOR EACH ROW EXECUTE FUNCTION kidmais_063_sem_exclusao();
CREATE TRIGGER kidmais_063_cad_sem_truncate_trg BEFORE TRUNCATE ON plataforma_empresas_cadastro
FOR EACH STATEMENT EXECUTE FUNCTION kidmais_063_sem_exclusao();

-- 4. Convites -------------------------------------------------------------------------------------------------------
CREATE TABLE convites_acesso (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL,
  email text NOT NULL,
  nome_sugerido text,
  papel varchar(32) NOT NULL,
  token_hash char(64) NOT NULL,
  status text NOT NULL DEFAULT 'PENDENTE',
  expira_em timestamptz NOT NULL,
  envios integer NOT NULL DEFAULT 0,
  ultimo_envio_em timestamptz,
  criado_por uuid NOT NULL,
  criado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  atualizado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  aceito_em timestamptz,
  aceito_usuario_id uuid,
  membership_id uuid,
  cancelado_em timestamptz,
  cancelado_por uuid,
  CONSTRAINT kidmais_063_conv_empresa_fk FOREIGN KEY (empresa_id) REFERENCES empresas (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT kidmais_063_conv_criado_por_fk FOREIGN KEY (criado_por) REFERENCES usuarios_administrativos (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT kidmais_063_conv_aceito_usuario_fk FOREIGN KEY (aceito_usuario_id) REFERENCES usuarios_administrativos (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT kidmais_063_conv_cancelado_por_fk FOREIGN KEY (cancelado_por) REFERENCES usuarios_administrativos (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  -- A membership do aceite é da MESMA empresa do convite.
  CONSTRAINT kidmais_063_conv_membership_fk FOREIGN KEY (empresa_id, membership_id) REFERENCES memberships (empresa_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT kidmais_063_conv_token_uk UNIQUE (token_hash),
  CONSTRAINT kidmais_063_conv_token_ck CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT kidmais_063_conv_email_ck CHECK (email = lower(btrim(email)) AND length(email) <= 254 AND email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  CONSTRAINT kidmais_063_conv_nome_ck CHECK (nome_sugerido IS NULL OR (nome_sugerido = btrim(nome_sugerido) AND length(nome_sugerido) BETWEEN 2 AND 120)),
  CONSTRAINT kidmais_063_conv_papel_ck CHECK (papel IN ('ADMINISTRATIVO', 'REPRESENTANTE_AUTORIZADO')),
  CONSTRAINT kidmais_063_conv_status_ck CHECK (status IN ('PENDENTE', 'ACEITO', 'CANCELADO')),
  CONSTRAINT kidmais_063_conv_envios_ck CHECK (envios >= 0 AND envios <= 50 AND ((envios = 0) = (ultimo_envio_em IS NULL))),
  CONSTRAINT kidmais_063_conv_expira_ck CHECK (expira_em > criado_em),
  CONSTRAINT kidmais_063_conv_aceite_ck CHECK (
    (status = 'ACEITO') = (aceito_em IS NOT NULL AND aceito_usuario_id IS NOT NULL AND membership_id IS NOT NULL)
    AND (status = 'ACEITO' OR (aceito_em IS NULL AND aceito_usuario_id IS NULL AND membership_id IS NULL))
  ),
  CONSTRAINT kidmais_063_conv_cancelamento_ck CHECK (
    (status = 'CANCELADO') = (cancelado_em IS NOT NULL AND cancelado_por IS NOT NULL)
    AND (status = 'CANCELADO' OR (cancelado_em IS NULL AND cancelado_por IS NULL))
  )
);
CREATE UNIQUE INDEX kidmais_063_conv_pendente_uk ON convites_acesso (empresa_id, email) WHERE status = 'PENDENTE';
CREATE INDEX kidmais_063_conv_empresa_idx ON convites_acesso (empresa_id, criado_em DESC);

CREATE FUNCTION kidmais_063_guard_convites()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $f$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status IS DISTINCT FROM 'PENDENTE' THEN RAISE EXCEPTION '063: convite novo começa pendente.'; END IF;
    NEW.criado_em := clock_timestamp();
    NEW.atualizado_em := NEW.criado_em;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.empresa_id IS DISTINCT FROM OLD.empresa_id OR NEW.email IS DISTINCT FROM OLD.email
     OR NEW.papel IS DISTINCT FROM OLD.papel OR NEW.criado_por IS DISTINCT FROM OLD.criado_por OR NEW.criado_em IS DISTINCT FROM OLD.criado_em THEN
    RAISE EXCEPTION '063: identidade do convite é imutável.';
  END IF;
  IF OLD.status <> 'PENDENTE' THEN RAISE EXCEPTION '063: convite % é imutável.', lower(OLD.status); END IF;
  IF NEW.status NOT IN ('PENDENTE', 'ACEITO', 'CANCELADO') THEN RAISE EXCEPTION '063: transição de convite recusada.'; END IF;
  IF NEW.status = 'ACEITO' AND OLD.expira_em <= clock_timestamp() THEN RAISE EXCEPTION '063: convite expirado não é aceito.'; END IF;
  IF NEW.status <> 'PENDENTE' AND (NEW.token_hash IS DISTINCT FROM OLD.token_hash OR NEW.expira_em IS DISTINCT FROM OLD.expira_em) THEN
    RAISE EXCEPTION '063: convite encerrado não renova token.';
  END IF;
  IF NEW.envios < OLD.envios THEN RAISE EXCEPTION '063: contador de envios não diminui.'; END IF;
  IF NEW.status = 'ACEITO' THEN NEW.aceito_em := clock_timestamp(); END IF;
  IF NEW.status = 'CANCELADO' THEN NEW.cancelado_em := clock_timestamp(); END IF;
  NEW.atualizado_em := clock_timestamp();
  RETURN NEW;
END;
$f$;
CREATE TRIGGER kidmais_063_conv_guard_trg BEFORE INSERT OR UPDATE ON convites_acesso
FOR EACH ROW EXECUTE FUNCTION kidmais_063_guard_convites();
CREATE TRIGGER kidmais_063_conv_sem_exclusao_trg BEFORE DELETE ON convites_acesso
FOR EACH ROW EXECUTE FUNCTION kidmais_063_sem_exclusao();
CREATE TRIGGER kidmais_063_conv_sem_truncate_trg BEFORE TRUNCATE ON convites_acesso
FOR EACH STATEMENT EXECUTE FUNCTION kidmais_063_sem_exclusao();

-- 5. Recuperação de senha -------------------------------------------------------------------------------------------
CREATE TABLE recuperacoes_senha (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id uuid NOT NULL,
  token_hash char(64) NOT NULL,
  origem text NOT NULL,
  solicitado_por uuid,
  criado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  expira_em timestamptz NOT NULL,
  usado_em timestamptz,
  invalidado_em timestamptz,
  CONSTRAINT kidmais_063_rec_usuario_fk FOREIGN KEY (usuario_id) REFERENCES usuarios_administrativos (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT kidmais_063_rec_solicitado_por_fk FOREIGN KEY (solicitado_por) REFERENCES usuarios_administrativos (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT kidmais_063_rec_token_uk UNIQUE (token_hash),
  CONSTRAINT kidmais_063_rec_token_ck CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT kidmais_063_rec_origem_ck CHECK (origem IN ('PUBLICA', 'PAINEL') AND ((origem = 'PAINEL') = (solicitado_por IS NOT NULL))),
  CONSTRAINT kidmais_063_rec_expira_ck CHECK (expira_em > criado_em AND expira_em <= criado_em + interval '2 hours'),
  CONSTRAINT kidmais_063_rec_encerramento_ck CHECK (usado_em IS NULL OR invalidado_em IS NULL)
);
CREATE UNIQUE INDEX kidmais_063_rec_aberta_uk ON recuperacoes_senha (usuario_id) WHERE usado_em IS NULL AND invalidado_em IS NULL;
CREATE INDEX kidmais_063_rec_usuario_idx ON recuperacoes_senha (usuario_id, criado_em DESC);

CREATE FUNCTION kidmais_063_guard_recuperacoes()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $f$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.usado_em IS NOT NULL OR NEW.invalidado_em IS NOT NULL THEN RAISE EXCEPTION '063: pedido novo começa aberto.'; END IF;
    NEW.criado_em := clock_timestamp();
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.usuario_id IS DISTINCT FROM OLD.usuario_id OR NEW.token_hash IS DISTINCT FROM OLD.token_hash
     OR NEW.origem IS DISTINCT FROM OLD.origem OR NEW.solicitado_por IS DISTINCT FROM OLD.solicitado_por
     OR NEW.criado_em IS DISTINCT FROM OLD.criado_em OR NEW.expira_em IS DISTINCT FROM OLD.expira_em THEN
    RAISE EXCEPTION '063: pedido de recuperação é imutável.';
  END IF;
  IF OLD.usado_em IS NOT NULL OR OLD.invalidado_em IS NOT NULL THEN RAISE EXCEPTION '063: pedido de recuperação já encerrado.'; END IF;
  IF NEW.usado_em IS NOT NULL THEN
    IF OLD.expira_em <= clock_timestamp() THEN RAISE EXCEPTION '063: pedido de recuperação expirado.'; END IF;
    NEW.usado_em := clock_timestamp();
  END IF;
  IF NEW.invalidado_em IS NOT NULL THEN NEW.invalidado_em := clock_timestamp(); END IF;
  RETURN NEW;
END;
$f$;
CREATE TRIGGER kidmais_063_rec_guard_trg BEFORE INSERT OR UPDATE ON recuperacoes_senha
FOR EACH ROW EXECUTE FUNCTION kidmais_063_guard_recuperacoes();
CREATE TRIGGER kidmais_063_rec_sem_exclusao_trg BEFORE DELETE ON recuperacoes_senha
FOR EACH ROW EXECUTE FUNCTION kidmais_063_sem_exclusao();
CREATE TRIGGER kidmais_063_rec_sem_truncate_trg BEFORE TRUNCATE ON recuperacoes_senha
FOR EACH STATEMENT EXECUTE FUNCTION kidmais_063_sem_exclusao();

-- 6. Ciclo da empresa com reativação ---------------------------------------------------------------------------------
CREATE FUNCTION kidmais_063_guard_empresas()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $guard$
DECLARE
  ator text;
  ator_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '063: exclusão física de empresa recusada.';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status IS DISTINCT FROM 'PROVISIONAMENTO' OR NEW.desativado_em IS NOT NULL THEN
      RAISE EXCEPTION '063: empresa nova começa em PROVISIONAMENTO.';
    END IF;
    NEW.criado_em := clock_timestamp();
    NEW.atualizado_em := NEW.criado_em;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.codigo IS DISTINCT FROM OLD.codigo
     OR NEW.criado_em IS DISTINCT FROM OLD.criado_em
     OR NEW.desativado_em IS DISTINCT FROM OLD.desativado_em THEN
    RAISE EXCEPTION '063: identidade da empresa é imutável. desativado_em não é carimbado pelo chamador.';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
         (OLD.status = 'PROVISIONAMENTO' AND NEW.status IN ('ATIVA', 'DESATIVADA'))
      OR (OLD.status = 'ATIVA' AND NEW.status IN ('SUSPENSA', 'DESATIVADA'))
      OR (OLD.status = 'SUSPENSA' AND NEW.status IN ('ATIVA', 'DESATIVADA'))
    ) THEN
      RAISE EXCEPTION '063: transição de empresa recusada.';
    END IF;
    IF NEW.status = 'DESATIVADA' THEN
      NEW.desativado_em := clock_timestamp();
    END IF;
    ator := nullif(current_setting('kidmais.ator_usuario_id', true), '');
    IF ator IS NULL THEN
      ator_id := NULL;
    ELSE
      BEGIN
        ator_id := ator::uuid;
      EXCEPTION WHEN invalid_text_representation THEN
        RAISE EXCEPTION '063: ator da transição inválido.';
      END;
      IF NOT EXISTS (
        SELECT 1 FROM usuarios_administrativos WHERE id = ator_id AND ativo
      ) THEN
        RAISE EXCEPTION '063: transição sem usuário administrativo ativo.';
      END IF;
    END IF;
    INSERT INTO auditoria (
      ator_tipo, usuario_id, acao, entidade_tipo, entidade_id,
      dados_antes, dados_depois, origem, criado_em
    ) VALUES (
      CASE WHEN ator_id IS NULL THEN 'SISTEMA' ELSE 'USUARIO' END,
      ator_id,
      'EMPRESA_TRANSICAO',
      'EMPRESA',
      NEW.id,
      jsonb_build_object('status', OLD.status),
      jsonb_build_object('status', NEW.status),
      'HG8_CICLO_EMPRESA',
      clock_timestamp()
    );
  END IF;
  NEW.atualizado_em := clock_timestamp();
  RETURN NEW;
END;
$guard$;

DROP TRIGGER empresas_guard_trg ON empresas;
CREATE TRIGGER empresas_guard_trg
BEFORE INSERT OR UPDATE OR DELETE ON empresas
FOR EACH ROW
EXECUTE FUNCTION kidmais_063_guard_empresas();

-- 7. Ciclo da membership com vínculo desativado (SUSPENSA) -----------------------------------------------------------
ALTER TABLE memberships DROP CONSTRAINT kidmais_043_memberships_status_ck;
ALTER TABLE memberships ADD CONSTRAINT kidmais_063_memberships_status_ck
  CHECK (status IN ('PENDENTE', 'ATIVA', 'SUSPENSA', 'REVOGADA'));

CREATE FUNCTION kidmais_063_guard_memberships()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $guard$
DECLARE
  ator text;
  ator_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '063: exclusão física de membership recusada.';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status IS DISTINCT FROM 'PENDENTE' OR NEW.revogado_em IS NOT NULL THEN
      RAISE EXCEPTION '063: membership nova começa pendente.';
    END IF;
    NEW.criado_em := clock_timestamp();
    NEW.atualizado_em := NEW.criado_em;
    NEW.vigente_desde := NEW.criado_em;
    NEW.revisao := 1;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.empresa_id IS DISTINCT FROM OLD.empresa_id
     OR NEW.usuario_id IS DISTINCT FROM OLD.usuario_id
     OR NEW.criado_em IS DISTINCT FROM OLD.criado_em
     OR NEW.vigente_desde IS DISTINCT FROM OLD.vigente_desde
     OR NEW.revogado_em IS DISTINCT FROM OLD.revogado_em THEN
    RAISE EXCEPTION '063: identidade da membership é imutável. revogado_em não é carimbado pelo chamador.';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
         (OLD.status = 'PENDENTE' AND NEW.status IN ('ATIVA', 'REVOGADA'))
      OR (OLD.status = 'ATIVA' AND NEW.status IN ('SUSPENSA', 'REVOGADA'))
      OR (OLD.status = 'SUSPENSA' AND NEW.status IN ('ATIVA', 'REVOGADA'))
    ) THEN
      RAISE EXCEPTION '063: transição de membership recusada.';
    END IF;
    IF NEW.status = 'REVOGADA' THEN
      NEW.revogado_em := clock_timestamp();
    END IF;
    NEW.revisao := OLD.revisao + 1;
    ator := nullif(current_setting('kidmais.ator_usuario_id', true), '');
    IF ator IS NULL THEN
      ator_id := NULL;
    ELSE
      BEGIN
        ator_id := ator::uuid;
      EXCEPTION WHEN invalid_text_representation THEN
        RAISE EXCEPTION '063: ator da transição inválido.';
      END;
      IF NOT EXISTS (
        SELECT 1 FROM usuarios_administrativos WHERE id = ator_id AND ativo
      ) THEN
        RAISE EXCEPTION '063: transição sem usuário administrativo ativo.';
      END IF;
    END IF;
    INSERT INTO auditoria (
      ator_tipo, usuario_id, acao, entidade_tipo, entidade_id,
      dados_antes, dados_depois, origem, criado_em
    ) VALUES (
      CASE WHEN ator_id IS NULL THEN 'SISTEMA' ELSE 'USUARIO' END,
      ator_id,
      'MEMBERSHIP_TRANSICAO',
      'MEMBERSHIP',
      NEW.id,
      jsonb_build_object('status', OLD.status),
      jsonb_build_object('status', NEW.status),
      'HG8_CICLO_MEMBERSHIP',
      clock_timestamp()
    );
  END IF;
  NEW.atualizado_em := clock_timestamp();
  RETURN NEW;
END;
$guard$;

DROP TRIGGER kidmais_043_memberships_guard_trg ON memberships;
CREATE TRIGGER kidmais_043_memberships_guard_trg
BEFORE INSERT OR UPDATE OR DELETE ON memberships
FOR EACH ROW
EXECUTE FUNCTION kidmais_063_guard_memberships();

COMMIT;
