-- Rollback 063 — devolve os ciclos de empresa (044) e membership (045) e remove as tabelas do painel do desenvolvedor.
-- NÃO APLICADO. Exige autorização explícita (docs/OPERACAO_AGENTES.md).
--
-- A 063 é aditiva fora dos dois guards: o código anterior não lê as tabelas novas e roda com elas presentes.
-- Por isso voltar o CÓDIGO não exige este rollback. Ele existe para desfazer a 063 ANTES do uso e recusa quando:
--   * há membership SUSPENSA (a 045 não conhece o status; reative ou revogue por decisão explícita antes);
--   * qualquer tabela nova tem linha (concessões, interessadas, cadastros, convites e recuperações são registros
--     administrativos; exportar e decidir antes — este script nunca apaga dado).
-- Empresa reativada pela 063 continua válida na 044 (ATIVA é um status da 044); só a transição SUSPENSA→ATIVA volta
-- a ser recusada.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = public, pg_catalog;
LOCK TABLE public.empresas, public.memberships IN SHARE ROW EXCLUSIVE MODE;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.sessoes_administrativas WHERE empresa_ativa_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Rollback 063: seleção de empresa já utilizada; preservada.';
  END IF;
  IF to_regclass('public.plataforma_desenvolvedores') IS NULL OR to_regprocedure('public.kidmais_063_guard_empresas()') IS NULL THEN
    RAISE EXCEPTION 'Rollback 063: não aplicada.';
  END IF;
  IF to_regprocedure('public.kidmais_044_guard_empresas()') IS NULL OR to_regprocedure('public.kidmais_045_guard_memberships()') IS NULL THEN
    RAISE EXCEPTION 'Rollback 063: guards da 044/045 ausentes.';
  END IF;
  IF (SELECT encode(sha256(convert_to(replace(prosrc, E'\r', ''), 'UTF8')), 'hex') FROM pg_proc WHERE oid = 'public.kidmais_044_guard_empresas()'::regprocedure) IS DISTINCT FROM 'c02a8c59927e4ece125273049d5185b60e0011cbac3e0dd456e182a0dcc78054'
     OR (SELECT encode(sha256(convert_to(replace(prosrc, E'\r', ''), 'UTF8')), 'hex') FROM pg_proc WHERE oid = 'public.kidmais_045_guard_memberships()'::regprocedure) IS DISTINCT FROM 'c47fb4bfe261d86042763748b28e1fae4d3b703cfebee37d1411ad61eef5fa60' THEN
    RAISE EXCEPTION 'Rollback 063: corpos dos guards da 044/045 divergem.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.memberships WHERE status = 'SUSPENSA') THEN
    RAISE EXCEPTION 'Rollback 063 recusado: há vínculo SUSPENSO; reative ou revogue por decisão explícita antes.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.plataforma_desenvolvedores) OR EXISTS (SELECT 1 FROM public.plataforma_interessadas)
     OR EXISTS (SELECT 1 FROM public.plataforma_empresas_cadastro) OR EXISTS (SELECT 1 FROM public.convites_acesso)
     OR EXISTS (SELECT 1 FROM public.recuperacoes_senha) THEN
    RAISE EXCEPTION 'Rollback 063 recusado: tabelas do painel têm registros. Volte só o código (a 063 é compatível) ou exporte e decida antes.';
  END IF;
END $$;

DROP TRIGGER kidmais_043_memberships_guard_trg ON public.memberships;
CREATE TRIGGER kidmais_043_memberships_guard_trg
BEFORE INSERT OR UPDATE OR DELETE ON public.memberships
FOR EACH ROW
EXECUTE FUNCTION kidmais_045_guard_memberships();
ALTER TABLE public.memberships DROP CONSTRAINT kidmais_063_memberships_status_ck;
ALTER TABLE public.memberships ADD CONSTRAINT kidmais_043_memberships_status_ck
  CHECK (status IN ('PENDENTE', 'ATIVA', 'REVOGADA'));
DROP FUNCTION public.kidmais_063_guard_memberships();

DROP TRIGGER empresas_guard_trg ON public.empresas;
CREATE TRIGGER empresas_guard_trg
BEFORE INSERT OR UPDATE OR DELETE ON public.empresas
FOR EACH ROW
EXECUTE FUNCTION kidmais_044_guard_empresas();
DROP FUNCTION public.kidmais_063_guard_empresas();

DROP TRIGGER kidmais_063_empresa_selecao_trg ON public.empresas;
DROP TRIGGER kidmais_063_membership_selecao_trg ON public.memberships;
DROP FUNCTION public.kidmais_063_invalidar_selecao();
ALTER TABLE public.sessoes_administrativas DROP COLUMN empresa_ativa_id;
DROP TABLE public.recuperacoes_senha;
DROP TABLE public.convites_acesso;
DROP TABLE public.plataforma_empresas_cadastro;
DROP TABLE public.plataforma_interessadas;
DROP TABLE public.plataforma_desenvolvedores;
DROP FUNCTION public.kidmais_063_guard_recuperacoes();
DROP FUNCTION public.kidmais_063_guard_convites();
DROP FUNCTION public.kidmais_063_guard_cadastro();
DROP FUNCTION public.kidmais_063_guard_interessadas();
DROP FUNCTION public.kidmais_063_guard_desenvolvedores();
DROP FUNCTION public.kidmais_063_sem_exclusao();

DO $$ BEGIN
  IF (SELECT tgfoid FROM pg_trigger WHERE tgrelid = 'public.empresas'::regclass AND tgname = 'empresas_guard_trg') IS DISTINCT FROM 'public.kidmais_044_guard_empresas()'::regprocedure
     OR (SELECT tgfoid FROM pg_trigger WHERE tgrelid = 'public.memberships'::regclass AND tgname = 'kidmais_043_memberships_guard_trg') IS DISTINCT FROM 'public.kidmais_045_guard_memberships()'::regprocedure
     OR to_regclass('public.plataforma_desenvolvedores') IS NOT NULL
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.memberships'::regclass AND conname = 'kidmais_043_memberships_status_ck') THEN
    RAISE EXCEPTION 'Rollback 063: estado final divergente.';
  END IF;
END $$;

COMMIT;
