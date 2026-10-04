-- 063 postcheck (somente leitura). Estrutura, gatilhos e regras mínimas instaladas; nenhuma concessão criada.
DO $$
DECLARE
  tabela text;
BEGIN
  FOREACH tabela IN ARRAY ARRAY['plataforma_desenvolvedores', 'plataforma_interessadas', 'plataforma_empresas_cadastro', 'convites_acesso', 'recuperacoes_senha'] LOOP
    IF to_regclass('public.' || tabela) IS NULL THEN RAISE EXCEPTION '063 postcheck: tabela % ausente.', tabela; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = ('public.' || tabela)::regclass AND tgfoid = 'public.kidmais_063_sem_exclusao()'::regprocedure AND NOT tgisinternal) THEN
      RAISE EXCEPTION '063 postcheck: % sem proteção contra exclusão.', tabela;
    END IF;
  END LOOP;
  IF (SELECT tgfoid FROM pg_trigger WHERE tgrelid = 'public.empresas'::regclass AND tgname = 'empresas_guard_trg') IS DISTINCT FROM 'public.kidmais_063_guard_empresas()'::regprocedure
     OR (SELECT tgfoid FROM pg_trigger WHERE tgrelid = 'public.memberships'::regclass AND tgname = 'kidmais_043_memberships_guard_trg') IS DISTINCT FROM 'public.kidmais_063_guard_memberships()'::regprocedure THEN
    RAISE EXCEPTION '063 postcheck: gatilhos de empresa/membership não apontam para a 063.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.memberships'::regclass AND conname = 'kidmais_063_memberships_status_ck')
     OR EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.memberships'::regclass AND conname = 'kidmais_043_memberships_status_ck') THEN
    RAISE EXCEPTION '063 postcheck: restrição de status da membership divergente.';
  END IF;
  IF to_regprocedure('public.kidmais_044_guard_empresas()') IS NULL OR to_regprocedure('public.kidmais_045_guard_memberships()') IS NULL THEN
    RAISE EXCEPTION '063 postcheck: funções da 044/045 precisam permanecer para o rollback.';
  END IF;
  IF to_regclass('public.kidmais_063_dev_ativo_uk') IS NULL OR to_regclass('public.kidmais_063_conv_pendente_uk') IS NULL
     OR to_regclass('public.kidmais_063_rec_aberta_uk') IS NULL OR to_regclass('public.kidmais_063_int_documento_uk') IS NULL THEN
    RAISE EXCEPTION '063 postcheck: índices únicos ausentes.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.plataforma_desenvolvedores) THEN
    RAISE EXCEPTION '063 postcheck: a migration não concede acesso de desenvolvedor.';
  END IF;
  RAISE NOTICE '063 postcheck OK.';
END $$;
