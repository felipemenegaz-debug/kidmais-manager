BEGIN;

-- Estrutura de tenant em cima da empresas canônica da 031.
-- Não cria outra empresas. Não copia os gates da foundation publicada.
-- Não semeia a Kidmais e não associa
-- pacote, tabela ou adicional. Pacotes continuam sem unidade_id.
--
-- Membership nasce só PENDENTE. ATIVA existe no check e permanece inalcançável
-- até a migration de ciclo. Não há coluna papel e não há status SUSPENSA.
-- Estabelecimento nasce SUSPENSO. O caminho operacional ATIVO/ATIVA da unidade
-- fica fechado enquanto D03 estiver adiado.

DO $$ BEGIN
  IF to_regclass('public.empresas') IS NULL
     OR to_regclass('public.usuarios_administrativos') IS NULL THEN
    RAISE EXCEPTION '043: empresas canônica ou usuários administrativos ausentes.';
  END IF;
  IF to_regclass('public.estabelecimentos') IS NOT NULL
     OR to_regclass('public.memberships') IS NOT NULL
     OR to_regclass('public.membership_estabelecimentos') IS NOT NULL THEN
    RAISE EXCEPTION '043: estrutura de tenant já existe.';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'pacotes'
       AND column_name = 'unidade_id'
  ) THEN
    RAISE EXCEPTION '043: pacotes não recebem unidade_id.';
  END IF;
END $$;

CREATE TABLE estabelecimentos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL,
  codigo text NOT NULL,
  nome text NOT NULL,
  status text NOT NULL,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  desativado_em timestamptz,
  CONSTRAINT kidmais_043_estabelecimentos_empresa_fk
    FOREIGN KEY (empresa_id) REFERENCES empresas (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT kidmais_043_estabelecimentos_empresa_id_uk UNIQUE (empresa_id, id),
  CONSTRAINT kidmais_043_estabelecimentos_codigo_uk UNIQUE (empresa_id, codigo),
  CONSTRAINT kidmais_043_estabelecimentos_codigo_ck
    CHECK (codigo COLLATE "C" ~ '^[a-z][a-z0-9-]{1,62}[a-z0-9]$'),
  CONSTRAINT kidmais_043_estabelecimentos_nome_ck
    CHECK (length(btrim(nome)) BETWEEN 1 AND 160),
  CONSTRAINT kidmais_043_estabelecimentos_status_ck
    CHECK (status IN ('ATIVO', 'SUSPENSO', 'DESATIVADO')),
  CONSTRAINT kidmais_043_estabelecimentos_datas_ck CHECK (
    atualizado_em >= criado_em
    AND (desativado_em IS NULL OR desativado_em >= criado_em)
    AND ((status = 'DESATIVADO') = (desativado_em IS NOT NULL))
  )
);

CREATE FUNCTION kidmais_043_guard_estabelecimentos()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $guard$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '043: exclusão física de estabelecimento recusada.';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status IS DISTINCT FROM 'SUSPENSO' OR NEW.desativado_em IS NOT NULL THEN
      RAISE EXCEPTION '043: estabelecimento novo começa suspenso.';
    END IF;
    NEW.criado_em := clock_timestamp();
    NEW.atualizado_em := NEW.criado_em;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.empresa_id IS DISTINCT FROM OLD.empresa_id
     OR NEW.codigo IS DISTINCT FROM OLD.codigo
     OR NEW.criado_em IS DISTINCT FROM OLD.criado_em
     OR NEW.desativado_em IS DISTINCT FROM OLD.desativado_em
     OR NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION '043: estabelecimento permanece não operacional. ATIVO está fechado.';
  END IF;
  NEW.atualizado_em := clock_timestamp();
  RETURN NEW;
END;
$guard$;

CREATE FUNCTION kidmais_043_bloquear_truncate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $guard$
BEGIN
  RAISE EXCEPTION '043: exclusão física recusada.';
END;
$guard$;

CREATE TRIGGER kidmais_043_estabelecimentos_guard_trg
BEFORE INSERT OR UPDATE OR DELETE ON estabelecimentos
FOR EACH ROW
EXECUTE FUNCTION kidmais_043_guard_estabelecimentos();

CREATE TRIGGER kidmais_043_estabelecimentos_truncate_trg
BEFORE TRUNCATE ON estabelecimentos
FOR EACH STATEMENT
EXECUTE FUNCTION kidmais_043_bloquear_truncate();

CREATE TABLE memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL,
  usuario_id uuid NOT NULL,
  status text NOT NULL,
  vigente_desde timestamptz NOT NULL,
  vigente_ate timestamptz,
  revogado_em timestamptz,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  revisao bigint NOT NULL DEFAULT 1,
  CONSTRAINT kidmais_043_memberships_empresa_fk
    FOREIGN KEY (empresa_id) REFERENCES empresas (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT kidmais_043_memberships_usuario_fk
    FOREIGN KEY (usuario_id) REFERENCES usuarios_administrativos (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT kidmais_043_memberships_empresa_id_uk UNIQUE (empresa_id, id),
  CONSTRAINT kidmais_043_memberships_empresa_usuario_uk UNIQUE (empresa_id, usuario_id),
  CONSTRAINT kidmais_043_memberships_empresa_id_usuario_uk UNIQUE (empresa_id, id, usuario_id),
  CONSTRAINT kidmais_043_memberships_status_ck
    CHECK (status IN ('PENDENTE', 'ATIVA', 'REVOGADA')),
  CONSTRAINT kidmais_043_memberships_datas_ck CHECK (
    atualizado_em >= criado_em
    AND (vigente_ate IS NULL OR vigente_ate > vigente_desde)
    AND (revogado_em IS NULL OR revogado_em >= criado_em)
    AND ((status = 'REVOGADA') = (revogado_em IS NOT NULL))
  ),
  CONSTRAINT kidmais_043_memberships_revisao_ck CHECK (revisao > 0)
);

CREATE INDEX kidmais_043_memberships_usuario_empresa_status_idx
  ON memberships (usuario_id, empresa_id, status);

CREATE FUNCTION kidmais_043_guard_memberships()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $guard$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '043: exclusão física de membership recusada.';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status IS DISTINCT FROM 'PENDENTE' OR NEW.revogado_em IS NOT NULL THEN
      RAISE EXCEPTION '043: membership nova começa pendente.';
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
     OR NEW.revogado_em IS DISTINCT FROM OLD.revogado_em
     OR NEW.revisao IS DISTINCT FROM OLD.revisao
     OR NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION '043: ativação de membership ainda fechada.';
  END IF;
  NEW.atualizado_em := clock_timestamp();
  RETURN NEW;
END;
$guard$;

CREATE TRIGGER kidmais_043_memberships_guard_trg
BEFORE INSERT OR UPDATE OR DELETE ON memberships
FOR EACH ROW
EXECUTE FUNCTION kidmais_043_guard_memberships();

CREATE TRIGGER kidmais_043_memberships_truncate_trg
BEFORE TRUNCATE ON memberships
FOR EACH STATEMENT
EXECUTE FUNCTION kidmais_043_bloquear_truncate();

CREATE TABLE membership_estabelecimentos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL,
  estabelecimento_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  status text NOT NULL,
  vigente_desde timestamptz NOT NULL,
  vigente_ate timestamptz,
  revogado_em timestamptz,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT kidmais_043_me_membership_fk
    FOREIGN KEY (empresa_id, membership_id)
    REFERENCES memberships (empresa_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT kidmais_043_me_estabelecimento_fk
    FOREIGN KEY (empresa_id, estabelecimento_id)
    REFERENCES estabelecimentos (empresa_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT kidmais_043_me_empresa_estab_membership_uk
    UNIQUE (empresa_id, estabelecimento_id, membership_id),
  CONSTRAINT kidmais_043_me_empresa_estab_id_uk
    UNIQUE (empresa_id, estabelecimento_id, id),
  CONSTRAINT kidmais_043_me_status_ck
    CHECK (status IN ('ATIVA', 'SUSPENSA', 'REVOGADA')),
  CONSTRAINT kidmais_043_me_datas_ck CHECK (
    atualizado_em >= criado_em
    AND (vigente_ate IS NULL OR vigente_ate > vigente_desde)
    AND (revogado_em IS NULL OR revogado_em >= criado_em)
    AND ((status = 'REVOGADA') = (revogado_em IS NOT NULL))
  )
);

CREATE INDEX kidmais_043_me_empresa_membership_estab_idx
  ON membership_estabelecimentos (empresa_id, membership_id, estabelecimento_id);

CREATE FUNCTION kidmais_043_guard_membership_estabelecimentos()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $guard$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '043: exclusão física de vínculo de unidade recusada.';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status IS DISTINCT FROM 'SUSPENSA' OR NEW.revogado_em IS NOT NULL THEN
      RAISE EXCEPTION '043: vínculo de unidade nasce suspenso. ATIVA está fechada.';
    END IF;
    NEW.criado_em := clock_timestamp();
    NEW.atualizado_em := NEW.criado_em;
    NEW.vigente_desde := NEW.criado_em;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.empresa_id IS DISTINCT FROM OLD.empresa_id
     OR NEW.estabelecimento_id IS DISTINCT FROM OLD.estabelecimento_id
     OR NEW.membership_id IS DISTINCT FROM OLD.membership_id
     OR NEW.criado_em IS DISTINCT FROM OLD.criado_em
     OR NEW.revogado_em IS DISTINCT FROM OLD.revogado_em
     OR NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION '043: caminho operacional da unidade permanece fechado.';
  END IF;
  NEW.atualizado_em := clock_timestamp();
  RETURN NEW;
END;
$guard$;

CREATE TRIGGER kidmais_043_me_guard_trg
BEFORE INSERT OR UPDATE OR DELETE ON membership_estabelecimentos
FOR EACH ROW
EXECUTE FUNCTION kidmais_043_guard_membership_estabelecimentos();

CREATE TRIGGER kidmais_043_me_truncate_trg
BEFORE TRUNCATE ON membership_estabelecimentos
FOR EACH STATEMENT
EXECUTE FUNCTION kidmais_043_bloquear_truncate();

COMMIT;
