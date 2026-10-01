BEGIN;

-- 056 — Autoridade por empresa (decisão de produto 2026-09-29).
--
--   Identidade administrativa é GLOBAL (usuarios_administrativos); acesso empresarial é a MEMBERSHIP.
--   1. memberships.papel: papel do usuário NAQUELA empresa (alterar em A não muda B). Backfill com o papel
--      atual da identidade; INSERT sem papel herda o da identidade (compatibilidade com provisionamento/046).
--   2. festa_membership_capacidades: capacidade de Festa por membership (empresa + membership, FK composta).
--      Backfill: cada capacidade global ativa vira uma por membership não revogada do usuário.
--      festa_usuario_capacidades (016) fica CONGELADA: nenhuma escrita nova (histórico preservado).
--   3. festa_areas: área pertence à empresa (empresa_id obrigatória) e, quando informado, ao estabelecimento
--      da mesma empresa (FK composta com estabelecimentos). Nome único por empresa. Backfill sem inventar:
--      empresa única das Festas que usam a área; sem uso, empresa única (membership não revogada) de quem a
--      criou; qualquer ambiguidade ou ausência aborta (a migration não corrige).
--   4. Tarefa/pendência: área e responsável precisam ser da empresa da Festa (a FK global não basta).
--
-- Não altera senha, e-mail, ativo nem o papel da identidade. Não cria empresa, estabelecimento nem membership.

SET LOCAL lock_timeout = '5s';

DO $$ BEGIN
  IF to_regclass('public.memberships') IS NULL OR to_regclass('public.estabelecimentos') IS NULL
     OR to_regclass('public.festa_areas') IS NULL OR to_regclass('public.festa_usuario_capacidades') IS NULL
     OR to_regclass('public.festa_tarefas') IS NULL OR to_regclass('public.festa_pendencias') IS NULL THEN
    RAISE EXCEPTION '056: estrutura de tenant (043/045) ou de Festa (016) ausente.';
  END IF;
  IF to_regclass('public.festa_membership_capacidades') IS NOT NULL
     OR EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'memberships' AND column_name = 'papel')
     OR EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'festa_areas' AND column_name = 'empresa_id') THEN
    RAISE EXCEPTION '056: já aplicada.';
  END IF;
END $$;

LOCK TABLE public.memberships, public.festa_areas, public.festa_usuario_capacidades, public.festa_tarefas, public.festa_pendencias
  IN SHARE ROW EXCLUSIVE MODE;

-- =============================================================================
-- 1. Papel por membership
-- =============================================================================
ALTER TABLE public.memberships ADD COLUMN papel varchar(32);
UPDATE public.memberships m SET papel = u.papel FROM public.usuarios_administrativos u WHERE u.id = m.usuario_id;
ALTER TABLE public.memberships ALTER COLUMN papel SET NOT NULL;
ALTER TABLE public.memberships ADD CONSTRAINT kidmais_056_memberships_papel_ck
  CHECK (papel IN ('ADMINISTRATIVO', 'REPRESENTANTE_AUTORIZADO'));

CREATE FUNCTION public.kidmais_056_membership_papel_padrao()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.papel IS NULL THEN
    SELECT u.papel INTO NEW.papel FROM public.usuarios_administrativos u WHERE u.id = NEW.usuario_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER kidmais_056_membership_papel_trg
BEFORE INSERT ON public.memberships
FOR EACH ROW EXECUTE FUNCTION public.kidmais_056_membership_papel_padrao();

-- =============================================================================
-- 2. Capacidade de Festa por membership
-- =============================================================================
CREATE TABLE public.festa_membership_capacidades (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  capacidade text NOT NULL,
  concedido_por uuid NOT NULL REFERENCES public.usuarios_administrativos (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  concedido_em timestamptz NOT NULL DEFAULT now(),
  motivo text NOT NULL,
  revogado_por uuid REFERENCES public.usuarios_administrativos (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  revogado_em timestamptz,
  motivo_revogacao text,
  CONSTRAINT kidmais_056_fmc_membership_fk FOREIGN KEY (empresa_id, membership_id)
    REFERENCES public.memberships (empresa_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT kidmais_056_fmc_capacidade_ck
    CHECK (capacidade IN ('FESTA_CONSULTAR', 'FESTA_CRIAR', 'FESTA_OPERAR', 'FESTA_CORRIGIR', 'FESTA_CONFIGURAR_AREAS')),
  CONSTRAINT kidmais_056_fmc_motivo_ck CHECK (length(btrim(motivo)) >= 3),
  CONSTRAINT kidmais_056_fmc_revogacao_ck CHECK (
    (revogado_por IS NULL AND revogado_em IS NULL AND motivo_revogacao IS NULL)
    OR (revogado_por IS NOT NULL AND revogado_em IS NOT NULL AND length(btrim(motivo_revogacao)) >= 3)
  )
);
CREATE UNIQUE INDEX kidmais_056_fmc_ativa_uk ON public.festa_membership_capacidades (membership_id, capacidade) WHERE revogado_em IS NULL;
CREATE INDEX kidmais_056_fmc_empresa_idx ON public.festa_membership_capacidades (empresa_id, membership_id);

CREATE FUNCTION public.kidmais_056_fmc_imutavel()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '056: capacidade de Festa não é apagada; revogue.';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.empresa_id IS DISTINCT FROM OLD.empresa_id
     OR NEW.membership_id IS DISTINCT FROM OLD.membership_id OR NEW.capacidade IS DISTINCT FROM OLD.capacidade
     OR NEW.concedido_por IS DISTINCT FROM OLD.concedido_por OR NEW.concedido_em IS DISTINCT FROM OLD.concedido_em
     OR NEW.motivo IS DISTINCT FROM OLD.motivo OR OLD.revogado_em IS NOT NULL THEN
    RAISE EXCEPTION '056: capacidade de Festa só pode ser revogada, uma vez.';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER kidmais_056_fmc_imutavel_trg
BEFORE UPDATE OR DELETE ON public.festa_membership_capacidades
FOR EACH ROW EXECUTE FUNCTION public.kidmais_056_fmc_imutavel();

INSERT INTO public.festa_membership_capacidades (empresa_id, membership_id, capacidade, concedido_por, concedido_em, motivo)
SELECT m.empresa_id, m.id, c.capacidade, c.concedido_por, c.concedido_em, c.motivo
  FROM public.festa_usuario_capacidades c
  JOIN public.memberships m ON m.usuario_id = c.usuario_id AND m.status <> 'REVOGADA'
 WHERE c.revogado_em IS NULL;

CREATE FUNCTION public.kidmais_056_capacidade_global_congelada()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION '056: capacidade global de Festa encerrada; use festa_membership_capacidades.' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER kidmais_056_capacidade_global_congelada_trg
BEFORE INSERT OR UPDATE OR DELETE ON public.festa_usuario_capacidades
FOR EACH ROW EXECUTE FUNCTION public.kidmais_056_capacidade_global_congelada();

-- =============================================================================
-- 3. Área pertence à empresa (e ao estabelecimento, quando informado)
-- =============================================================================
ALTER TABLE public.festa_areas ADD COLUMN empresa_id uuid, ADD COLUMN estabelecimento_id uuid;

DO $$
DECLARE
  sem_empresa integer;
BEGIN
  WITH uso AS (
    SELECT t.area_id, fe.empresa_id
      FROM (SELECT area_id, festa_id FROM public.festa_tarefas WHERE area_id IS NOT NULL
            UNION SELECT area_id, festa_id FROM public.festa_pendencias WHERE area_id IS NOT NULL) t
      JOIN public.festas f ON f.id = t.festa_id
      JOIN public.contratos c ON c.id = f.contrato_id
      JOIN public.fechamentos fe ON fe.id = c.fechamento_id
  ), por_uso AS (
    SELECT area_id, CASE WHEN count(DISTINCT empresa_id) = 1 AND bool_and(empresa_id IS NOT NULL) THEN min(empresa_id::text)::uuid END AS empresa_id
      FROM uso GROUP BY area_id
  ), por_criador AS (
    SELECT a.id AS area_id, CASE WHEN count(DISTINCT m.empresa_id) = 1 THEN min(m.empresa_id::text)::uuid END AS empresa_id
      FROM public.festa_areas a
      JOIN public.memberships m ON m.usuario_id = a.criado_por AND m.status <> 'REVOGADA'
     WHERE NOT EXISTS (SELECT 1 FROM por_uso u WHERE u.area_id = a.id)
     GROUP BY a.id
  )
  UPDATE public.festa_areas a
     SET empresa_id = COALESCE((SELECT u.empresa_id FROM por_uso u WHERE u.area_id = a.id),
                               (SELECT c.empresa_id FROM por_criador c WHERE c.area_id = a.id));
  SELECT count(*) INTO sem_empresa FROM public.festa_areas WHERE empresa_id IS NULL;
  IF sem_empresa > 0 THEN
    RAISE EXCEPTION '056: % área(s) de Festa sem empresa única (uso em empresas distintas, legado ou criador sem vínculo único). A migration não corrige.', sem_empresa;
  END IF;
END $$;

ALTER TABLE public.festa_areas ALTER COLUMN empresa_id SET NOT NULL;
ALTER TABLE public.festa_areas
  ADD CONSTRAINT kidmais_056_festa_areas_empresa_fk FOREIGN KEY (empresa_id) REFERENCES public.empresas (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  ADD CONSTRAINT kidmais_056_festa_areas_estabelecimento_fk FOREIGN KEY (empresa_id, estabelecimento_id)
    REFERENCES public.estabelecimentos (empresa_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  ADD CONSTRAINT kidmais_056_festa_areas_empresa_id_uk UNIQUE (empresa_id, id);
DROP INDEX public.festa_areas_nome_uk;
CREATE UNIQUE INDEX kidmais_056_festa_areas_nome_uk ON public.festa_areas (empresa_id, lower(btrim(nome)));

CREATE FUNCTION public.kidmais_056_area_escopo_imutavel()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.empresa_id IS DISTINCT FROM OLD.empresa_id OR NEW.estabelecimento_id IS DISTINCT FROM OLD.estabelecimento_id THEN
    RAISE EXCEPTION '056: empresa e estabelecimento da área não mudam.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER kidmais_056_area_escopo_imutavel_trg
BEFORE UPDATE OF empresa_id, estabelecimento_id ON public.festa_areas
FOR EACH ROW EXECUTE FUNCTION public.kidmais_056_area_escopo_imutavel();

-- =============================================================================
-- 4. Tarefa/pendência: área e responsável da empresa da Festa (vínculo novo ou alterado)
-- =============================================================================
CREATE FUNCTION public.kidmais_056_festa_filho_empresa()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  empresa uuid;
BEGIN
  SELECT fe.empresa_id INTO empresa
    FROM public.festas f
    JOIN public.contratos c ON c.id = f.contrato_id
    JOIN public.fechamentos fe ON fe.id = c.fechamento_id
   WHERE f.id = NEW.festa_id;
  IF NEW.area_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.area_id IS DISTINCT FROM OLD.area_id OR NEW.festa_id IS DISTINCT FROM OLD.festa_id)
     AND NOT EXISTS (SELECT 1 FROM public.festa_areas a WHERE a.id = NEW.area_id AND a.empresa_id = empresa) THEN
    RAISE EXCEPTION '056: área de outra empresa.' USING ERRCODE = '23514';
  END IF;
  IF NEW.responsavel_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.responsavel_id IS DISTINCT FROM OLD.responsavel_id OR NEW.festa_id IS DISTINCT FROM OLD.festa_id)
     AND NOT EXISTS (SELECT 1 FROM public.memberships m WHERE m.usuario_id = NEW.responsavel_id AND m.empresa_id = empresa AND m.status = 'ATIVA') THEN
    RAISE EXCEPTION '056: responsável sem vínculo ativo na empresa da Festa.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER kidmais_056_festa_tarefas_empresa_trg
BEFORE INSERT OR UPDATE OF area_id, responsavel_id, festa_id ON public.festa_tarefas
FOR EACH ROW EXECUTE FUNCTION public.kidmais_056_festa_filho_empresa();
CREATE TRIGGER kidmais_056_festa_pendencias_empresa_trg
BEFORE INSERT OR UPDATE OF area_id, responsavel_id, festa_id ON public.festa_pendencias
FOR EACH ROW EXECUTE FUNCTION public.kidmais_056_festa_filho_empresa();

COMMIT;
