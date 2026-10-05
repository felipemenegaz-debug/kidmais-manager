-- 063 precheck (somente leitura). Pré-requisitos e corpos exatos dos guards substituídos (044/045).
DO $$
DECLARE
  empresas_suspensas integer;
BEGIN
  IF to_regclass('public.plataforma_desenvolvedores') IS NOT NULL THEN RAISE EXCEPTION '063 precheck: já aplicada.'; END IF;
  IF to_regclass('public.empresa_membership_capacidades') IS NULL THEN RAISE EXCEPTION '063 precheck: 057 não aplicada.'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'memberships' AND column_name = 'papel') THEN
    RAISE EXCEPTION '063 precheck: 056 não aplicada.';
  END IF;
  IF (SELECT tgfoid FROM pg_trigger WHERE tgrelid = 'public.empresas'::regclass AND tgname = 'empresas_guard_trg') IS DISTINCT FROM 'public.kidmais_044_guard_empresas()'::regprocedure
     OR (SELECT tgfoid FROM pg_trigger WHERE tgrelid = 'public.memberships'::regclass AND tgname = 'kidmais_043_memberships_guard_trg') IS DISTINCT FROM 'public.kidmais_045_guard_memberships()'::regprocedure THEN
    RAISE EXCEPTION '063 precheck: gatilhos de empresa/membership não apontam para a 044/045.';
  END IF;
  IF (SELECT encode(sha256(convert_to(replace(prosrc, E'\r', ''), 'UTF8')), 'hex') FROM pg_proc WHERE oid = 'public.kidmais_044_guard_empresas()'::regprocedure) IS DISTINCT FROM 'c02a8c59927e4ece125273049d5185b60e0011cbac3e0dd456e182a0dcc78054'
     OR (SELECT encode(sha256(convert_to(replace(prosrc, E'\r', ''), 'UTF8')), 'hex') FROM pg_proc WHERE oid = 'public.kidmais_045_guard_memberships()'::regprocedure) IS DISTINCT FROM 'c47fb4bfe261d86042763748b28e1fae4d3b703cfebee37d1411ad61eef5fa60' THEN
    RAISE EXCEPTION '063 precheck: corpos dos guards da 044/045 divergem.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.memberships WHERE status NOT IN ('PENDENTE', 'ATIVA', 'REVOGADA')) THEN
    RAISE EXCEPTION '063 precheck: membership com status fora da 045.';
  END IF;
  SELECT count(*) INTO empresas_suspensas FROM public.empresas WHERE status = 'SUSPENSA';
  RAISE NOTICE '063 precheck OK. Empresas suspensas hoje: % (passam a poder ser reativadas por ação explícita). Nenhuma linha existente é alterada.', empresas_suspensas;
END $$;
