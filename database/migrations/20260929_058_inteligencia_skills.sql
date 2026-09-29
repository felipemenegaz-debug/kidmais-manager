-- 058 — Kidmais Intelligence (SKILLS): armazenamento das camadas de skill da EMPRESA e do ESTABELECIMENTO.
--
-- NÃO APLICADA. Exige autorização explícita (docs/OPERACAO_AGENTES.md) para qualquer banco, inclusive staging
-- e clones. Sem esta migration a IA segue só com as skills da PLATAFORMA (código revisado); a camada de
-- empresa/unidade também depende de AI_SKILLS_EMPRESA_ENABLED=true.
--
--   ia_skills  uma linha por VERSÃO de skill de empresa (nivel EMPRESA) ou de unidade (nivel ESTABELECIMENTO),
--              sempre override de uma skill da plataforma de mesmo id (conferido pela aplicação). `definicao` é a
--              skill completa (schema do Skills V1: proveniência, revisão, hash, permissões, restrições, conteúdo),
--              validada e varrida pela aplicação ao ler; aqui só o que o banco consegue garantir:
--   * escopo coerente: EMPRESA ⇔ estabelecimento_id NULL; unidade da MESMA empresa (FK composta);
--   * a definição bate com as colunas (id, versão, hash, nível, empresa e unidade);
--   * versão imutável: só o status muda (nova versão = nova linha); sem DELETE nem TRUNCATE;
--   * no máximo UMA versão ATIVA por (empresa, unidade, skill);
--   * status: RASCUNHO → ATIVA ↔ SUSPENSA → ARQUIVADA (ARQUIVADA é final).
-- Sem escrita pela IA: nenhuma ferramenta, rota ou agente grava aqui (o cadastro/aprovação é fluxo futuro do Admin).
BEGIN;

DO $$ BEGIN
  IF to_regclass('public.empresas') IS NULL OR to_regclass('public.estabelecimentos') IS NULL
     OR to_regclass('public.usuarios_administrativos') IS NULL THEN
    RAISE EXCEPTION '058 exige empresas, estabelecimentos e usuarios_administrativos.';
  END IF;
  IF to_regclass('public.ia_skills') IS NOT NULL THEN
    RAISE EXCEPTION '058 já aplicada.';
  END IF;
END $$;

CREATE TABLE ia_skills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  estabelecimento_id uuid,
  nivel varchar(16) NOT NULL CHECK (nivel IN ('EMPRESA', 'ESTABELECIMENTO')),
  skill_id varchar(50) NOT NULL CHECK (skill_id ~ '^[a-z][a-z0-9_]{2,48}$'),
  versao varchar(20) NOT NULL CHECK (versao ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  hash char(64) NOT NULL CHECK (hash ~ '^[0-9a-f]{64}$'),
  status varchar(16) NOT NULL CHECK (status IN ('RASCUNHO', 'ATIVA', 'SUSPENSA', 'ARQUIVADA')),
  definicao jsonb NOT NULL CHECK (jsonb_typeof(definicao) = 'object'),
  criado_por uuid NOT NULL REFERENCES usuarios_administrativos(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  criado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  atualizado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT ia_skills_058_escopo_check CHECK ((nivel = 'ESTABELECIMENTO') = (estabelecimento_id IS NOT NULL)),
  CONSTRAINT ia_skills_058_estabelecimento_fk FOREIGN KEY (empresa_id, estabelecimento_id)
    REFERENCES estabelecimentos (empresa_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT ia_skills_058_definicao_check CHECK (
    definicao->>'id' = skill_id
    AND definicao->>'versao' = versao
    AND definicao->>'hash' = hash
    AND definicao->>'nivel' = nivel
    AND definicao->'escopo'->>'empresaId' = empresa_id::text
    AND (definicao->'escopo'->>'estabelecimentoId') IS NOT DISTINCT FROM estabelecimento_id::text
  ),
  CONSTRAINT ia_skills_058_datas_check CHECK (atualizado_em >= criado_em),
  CONSTRAINT ia_skills_058_versao_uk UNIQUE NULLS NOT DISTINCT (empresa_id, estabelecimento_id, skill_id, versao)
);
CREATE UNIQUE INDEX ia_skills_058_uma_ativa_uk ON ia_skills (empresa_id, estabelecimento_id, skill_id) NULLS NOT DISTINCT
  WHERE status = 'ATIVA';
CREATE INDEX ia_skills_058_empresa_status_idx ON ia_skills (empresa_id, status);

CREATE FUNCTION kidmais_058_skill_guarda() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '058: exclusão de skill recusada (arquive a versão).' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.empresa_id IS DISTINCT FROM OLD.empresa_id
     OR NEW.estabelecimento_id IS DISTINCT FROM OLD.estabelecimento_id OR NEW.nivel IS DISTINCT FROM OLD.nivel
     OR NEW.skill_id IS DISTINCT FROM OLD.skill_id OR NEW.versao IS DISTINCT FROM OLD.versao
     OR NEW.hash IS DISTINCT FROM OLD.hash OR NEW.definicao IS DISTINCT FROM OLD.definicao
     OR NEW.criado_por IS DISTINCT FROM OLD.criado_por OR NEW.criado_em IS DISTINCT FROM OLD.criado_em THEN
    RAISE EXCEPTION '058: versão de skill é imutável; crie uma nova versão.' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'RASCUNHO' AND NEW.status IN ('ATIVA', 'ARQUIVADA'))
    OR (OLD.status = 'ATIVA' AND NEW.status IN ('SUSPENSA', 'ARQUIVADA'))
    OR (OLD.status = 'SUSPENSA' AND NEW.status IN ('ATIVA', 'ARQUIVADA'))
  ) THEN
    RAISE EXCEPTION '058: transição de status % → % recusada.', OLD.status, NEW.status USING ERRCODE = 'P0001';
  END IF;
  NEW.atualizado_em := clock_timestamp();
  RETURN NEW;
END $$;

CREATE FUNCTION kidmais_058_bloquear_truncate() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION '058: TRUNCATE de ia_skills recusado.' USING ERRCODE = 'P0001';
END $$;

CREATE TRIGGER ia_skills_058_guarda_trg BEFORE UPDATE OR DELETE ON ia_skills
  FOR EACH ROW EXECUTE FUNCTION kidmais_058_skill_guarda();
CREATE TRIGGER ia_skills_058_truncate_trg BEFORE TRUNCATE ON ia_skills
  FOR EACH STATEMENT EXECUTE FUNCTION kidmais_058_bloquear_truncate();

COMMIT;
