-- Precheck da 110 (pesquisa de satisfação): somente leitura. Exige 043, 054 e 086 e confirma que nada da 110 existe.
BEGIN TRANSACTION READ ONLY;
DO $$ BEGIN
  IF to_regclass('public.marketing_automacao_execucoes') IS NULL OR to_regprocedure('public.kidmais086_execucao_tenant()') IS NULL THEN
    RAISE EXCEPTION 'precheck 110: 086 ausente';
  END IF;
  -- M4: empresa imutável em clientes e fechamentos (054), habilitada e apontando para a função da 054.
  IF (SELECT count(*) FROM pg_trigger t WHERE t.tgname IN ('clientes_054_empresa_imutavel_trg', 'fechamentos_054_empresa_imutavel_trg')
        AND t.tgenabled = 'O' AND NOT t.tgisinternal AND t.tgfoid = 'public.kidmais_054_empresa_imutavel()'::regprocedure) <> 2 THEN
    RAISE EXCEPTION 'precheck 110: gatilhos de empresa imutável da 054 ausentes, desligados ou com outra função';
  END IF;
  -- D-PS8: o guard da 043 atualiza atualizado_em em todo UPDATE do vínculo por unidade (a foto da concessão depende disso).
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'kidmais_043_me_guard_trg' AND tgenabled = 'O'
                   AND tgfoid = 'public.kidmais_043_guard_membership_estabelecimentos()'::regprocedure)
     OR position('NEW.atualizado_em := clock_timestamp()' IN pg_get_functiondef('public.kidmais_043_guard_membership_estabelecimentos()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'precheck 110: guard da 043 ausente ou sem a atualização de atualizado_em';
  END IF;
  IF to_regclass('public.satisfacao_envios') IS NOT NULL OR to_regclass('public.satisfacao_respostas') IS NOT NULL
     OR to_regclass('public.satisfacao_entregas') IS NOT NULL OR to_regprocedure('public.kidmais110_envio_guarda()') IS NOT NULL
     OR EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'marketing_automacao_regras' AND column_name = 'canais') THEN
    RAISE EXCEPTION 'precheck 110: 110 já presente (total ou parcialmente)';
  END IF;
END $$;
ROLLBACK;
