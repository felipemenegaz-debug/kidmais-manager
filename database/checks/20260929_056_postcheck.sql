-- 056 postcheck (somente leitura): objetos, backfill completo e isolamento das capacidades.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'memberships' AND column_name = 'papel' AND is_nullable = 'NO') THEN
    RAISE EXCEPTION '056 postcheck: memberships.papel ausente ou anulável.';
  END IF;
  IF to_regclass('public.festa_membership_capacidades') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'kidmais_056_fmc_membership_fk')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'kidmais_056_capacidade_global_congelada_trg' AND NOT tgisinternal AND tgenabled = 'O') THEN
    RAISE EXCEPTION '056 postcheck: capacidade por membership incompleta.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'festa_areas' AND column_name = 'empresa_id' AND is_nullable = 'NO')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'kidmais_056_festa_areas_estabelecimento_fk')
     OR to_regclass('public.kidmais_056_festa_areas_nome_uk') IS NULL OR to_regclass('public.festa_areas_nome_uk') IS NOT NULL THEN
    RAISE EXCEPTION '056 postcheck: escopo de área incompleto.';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgname IN ('kidmais_056_festa_tarefas_empresa_trg', 'kidmais_056_festa_pendencias_empresa_trg', 'kidmais_056_membership_papel_trg', 'kidmais_056_area_escopo_imutavel_trg', 'kidmais_056_fmc_imutavel_trg') AND NOT tgisinternal AND tgenabled = 'O') <> 5 THEN
    RAISE EXCEPTION '056 postcheck: gatilhos da 056 ausentes ou desabilitados.';
  END IF;
  -- Toda capacidade global ativa virou capacidade de cada membership não revogada do usuário.
  IF EXISTS (
    SELECT 1 FROM public.festa_usuario_capacidades c
      JOIN public.memberships m ON m.usuario_id = c.usuario_id AND m.status <> 'REVOGADA'
     WHERE c.revogado_em IS NULL
       AND NOT EXISTS (SELECT 1 FROM public.festa_membership_capacidades n WHERE n.membership_id = m.id AND n.capacidade = c.capacidade AND n.revogado_em IS NULL)
  ) THEN
    RAISE EXCEPTION '056 postcheck: backfill de capacidades incompleto.';
  END IF;
  -- Nenhuma capacidade aponta para membership de outra empresa (a FK composta garante; conferência explícita).
  IF EXISTS (SELECT 1 FROM public.festa_membership_capacidades n JOIN public.memberships m ON m.id = n.membership_id WHERE m.empresa_id <> n.empresa_id) THEN
    RAISE EXCEPTION '056 postcheck: capacidade fora da empresa da membership.';
  END IF;
END $$;
