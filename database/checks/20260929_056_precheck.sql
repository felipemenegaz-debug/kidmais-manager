-- 056 precheck (somente leitura): pré-requisitos e áreas cujo dono não é único (a migration abortaria).
DO $$
DECLARE
  ambiguas integer;
BEGIN
  IF to_regclass('public.memberships') IS NULL OR to_regclass('public.estabelecimentos') IS NULL
     OR to_regclass('public.festa_areas') IS NULL OR to_regclass('public.festa_usuario_capacidades') IS NULL THEN
    RAISE EXCEPTION '056 precheck: estrutura de tenant (043/045) ou de Festa (016) ausente.';
  END IF;
  IF to_regprocedure('public.kidmais_045_guard_memberships()') IS NULL
     AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'kidmais_043_memberships_guard_trg') THEN
    RAISE EXCEPTION '056 precheck: guarda de membership ausente.';
  END IF;
  IF to_regclass('public.festa_membership_capacidades') IS NOT NULL
     OR EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'memberships' AND column_name = 'papel') THEN
    RAISE EXCEPTION '056 precheck: 056 já aplicada.';
  END IF;
  WITH uso AS (
    SELECT t.area_id, fe.empresa_id
      FROM (SELECT area_id, festa_id FROM public.festa_tarefas WHERE area_id IS NOT NULL
            UNION SELECT area_id, festa_id FROM public.festa_pendencias WHERE area_id IS NOT NULL) t
      JOIN public.festas f ON f.id = t.festa_id
      JOIN public.contratos c ON c.id = f.contrato_id
      JOIN public.fechamentos fe ON fe.id = c.fechamento_id
  ), dono AS (
    SELECT a.id,
           CASE WHEN EXISTS (SELECT 1 FROM uso u WHERE u.area_id = a.id)
                THEN (SELECT count(DISTINCT u.empresa_id) = 1 AND bool_and(u.empresa_id IS NOT NULL) FROM uso u WHERE u.area_id = a.id)
                ELSE (SELECT count(DISTINCT m.empresa_id) = 1 FROM public.memberships m WHERE m.usuario_id = a.criado_por AND m.status <> 'REVOGADA')
           END AS unico
      FROM public.festa_areas a
  )
  SELECT count(*) INTO ambiguas FROM dono WHERE NOT unico;
  IF ambiguas > 0 THEN
    RAISE EXCEPTION '056 precheck: % área(s) de Festa sem empresa única. Decida o dono antes de aplicar.', ambiguas;
  END IF;
END $$;
