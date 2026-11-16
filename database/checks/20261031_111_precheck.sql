-- Precheck da 111 (links de avaliação e auditoria da pesquisa): somente leitura. Exige PostgreSQL 15+ e a 110, e
-- confirma que nenhum objeto da 111 existe (instalação parcial também recusa).
BEGIN TRANSACTION READ ONLY;
DO $$ BEGIN
  IF current_setting('server_version_num')::int < 150000 THEN RAISE EXCEPTION 'precheck 111: PostgreSQL 15+ exigido'; END IF;
  IF to_regclass('public.satisfacao_tarefas') IS NULL OR to_regclass('public.satisfacao_envios') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'satisfacao_tarefas_escopo_uk' AND conrelid = 'public.satisfacao_tarefas'::regclass AND contype = 'u')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'satisfacao_tarefas_guarda' AND tgrelid = 'public.satisfacao_tarefas'::regclass
                      AND tgenabled = 'O' AND tgfoid = 'public.kidmais110_tarefa_guarda()'::regprocedure) THEN
    RAISE EXCEPTION 'precheck 111: 110 ausente ou incompleta';
  END IF;
  IF to_regclass('public.satisfacao_links_avaliacao') IS NOT NULL OR to_regclass('public.satisfacao_auditoria') IS NOT NULL
     OR to_regprocedure('public.kidmais111_link_guarda()') IS NOT NULL OR to_regprocedure('public.kidmais111_auditoria_somente_insercao()') IS NOT NULL
     OR to_regprocedure('public.kidmais111_auditoria_coerencia()') IS NOT NULL THEN
    RAISE EXCEPTION 'precheck 111: 111 já presente (total ou parcialmente)';
  END IF;
END $$;
ROLLBACK;
