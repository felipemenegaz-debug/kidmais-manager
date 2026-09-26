BEGIN;

-- Empresas vazia, no shape da fundação 020, sem copiar aquele arquivo.
-- Não cria estabelecimentos, memberships nem unidade_id.
-- Não associa os sete pacotes atuais: empresa_id nasce nulo (HG-6).
DO $$ BEGIN
  IF to_regclass('public.pacotes') IS NULL
     OR to_regclass('public.tabelas_preco') IS NULL
     OR to_regclass('public.adicionais') IS NULL THEN
    RAISE EXCEPTION '031: catálogo comercial ausente.';
  END IF;
  IF to_regclass('public.empresas') IS NOT NULL
     OR to_regclass('public.estabelecimentos') IS NOT NULL
     OR to_regclass('public.memberships') IS NOT NULL
     OR to_regclass('public.membership_estabelecimentos') IS NOT NULL THEN
    RAISE EXCEPTION '031: fundação SaaS já existe; não recriar empresas.';
  END IF;
END $$;

CREATE TABLE empresas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo text NOT NULL,
  nome text NOT NULL,
  status text NOT NULL,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  desativado_em timestamptz,
  CONSTRAINT empresas_codigo_uk UNIQUE (codigo),
  CONSTRAINT empresas_codigo_ck CHECK (codigo COLLATE "C" ~ '^[a-z][a-z0-9-]{1,62}[a-z0-9]$'),
  CONSTRAINT empresas_nome_ck CHECK (length(btrim(nome)) BETWEEN 1 AND 160),
  CONSTRAINT empresas_status_ck CHECK (status IN ('PROVISIONAMENTO', 'ATIVA', 'SUSPENSA', 'DESATIVADA')),
  CONSTRAINT empresas_datas_ck CHECK (
    atualizado_em >= criado_em
    AND (desativado_em IS NULL OR desativado_em >= criado_em)
    AND ((status = 'DESATIVADA') = (desativado_em IS NOT NULL))
  )
);

CREATE FUNCTION kidmais_031_guard_empresas()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '031: exclusão física de empresa recusada.';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status IS DISTINCT FROM 'PROVISIONAMENTO' OR NEW.desativado_em IS NOT NULL THEN
      RAISE EXCEPTION '031: empresa nova começa em PROVISIONAMENTO.';
    END IF;
    NEW.criado_em := clock_timestamp();
    NEW.atualizado_em := NEW.criado_em;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.codigo IS DISTINCT FROM OLD.codigo
     OR NEW.criado_em IS DISTINCT FROM OLD.criado_em THEN
    RAISE EXCEPTION '031: identidade da empresa é imutável.';
  END IF;
  IF NEW.status = 'DESATIVADA' AND NEW.desativado_em IS NULL THEN
    NEW.desativado_em := clock_timestamp();
  END IF;
  IF NEW.status IS DISTINCT FROM 'DESATIVADA' THEN
    NEW.desativado_em := NULL;
  END IF;
  NEW.atualizado_em := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE FUNCTION kidmais_031_bloquear_truncate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '031: exclusão física de empresa recusada.';
END;
$$;

CREATE TRIGGER empresas_guard_trg
BEFORE INSERT OR UPDATE OR DELETE ON empresas
FOR EACH ROW
EXECUTE FUNCTION kidmais_031_guard_empresas();

CREATE TRIGGER empresas_truncate_trg
BEFORE TRUNCATE ON empresas
FOR EACH STATEMENT
EXECUTE FUNCTION kidmais_031_bloquear_truncate();

ALTER TABLE pacotes ADD COLUMN empresa_id uuid;
ALTER TABLE tabelas_preco ADD COLUMN empresa_id uuid;
ALTER TABLE adicionais ADD COLUMN empresa_id uuid;

ALTER TABLE pacotes
  ADD CONSTRAINT pacotes_empresa_fk
  FOREIGN KEY (empresa_id) REFERENCES empresas(id) ON UPDATE RESTRICT ON DELETE RESTRICT;
ALTER TABLE tabelas_preco
  ADD CONSTRAINT tabelas_preco_empresa_fk
  FOREIGN KEY (empresa_id) REFERENCES empresas(id) ON UPDATE RESTRICT ON DELETE RESTRICT;
ALTER TABLE adicionais
  ADD CONSTRAINT adicionais_empresa_fk
  FOREIGN KEY (empresa_id) REFERENCES empresas(id) ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE pacotes DROP CONSTRAINT pacotes_codigo_uk;
ALTER TABLE tabelas_preco DROP CONSTRAINT tabelas_preco_codigo_uk;
ALTER TABLE adicionais DROP CONSTRAINT adicionais_codigo_uk;

CREATE UNIQUE INDEX pacotes_empresa_codigo_uk ON pacotes (empresa_id, codigo) WHERE empresa_id IS NOT NULL;
CREATE UNIQUE INDEX pacotes_codigo_legado_uk ON pacotes (codigo) WHERE empresa_id IS NULL;
CREATE UNIQUE INDEX tabelas_preco_empresa_codigo_uk ON tabelas_preco (empresa_id, codigo) WHERE empresa_id IS NOT NULL;
CREATE UNIQUE INDEX tabelas_preco_codigo_legado_uk ON tabelas_preco (codigo) WHERE empresa_id IS NULL;
CREATE UNIQUE INDEX adicionais_empresa_codigo_uk ON adicionais (empresa_id, codigo) WHERE empresa_id IS NOT NULL;
CREATE UNIQUE INDEX adicionais_codigo_legado_uk ON adicionais (codigo) WHERE empresa_id IS NULL;

COMMIT;
