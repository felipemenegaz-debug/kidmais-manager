-- Precheck da 102 (somente leitura): 093 presente, 098 ausente e nenhum objeto da 102 (ausência completa; parcial recusa).
DO $$
BEGIN
  IF to_regclass('public.agenda_saloes') IS NULL OR to_regclass('public.usuarios_administrativos') IS NULL
    OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.agenda_saloes'::regclass AND conname = 'agenda_saloes_empresa_id_uk') THEN
    RAISE EXCEPTION '102 precheck: 093 ausente';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'agenda_saloes' AND column_name IN ('combinado', 'membros'))
    OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname LIKE 'kidmais098\_%') THEN
    RAISE EXCEPTION '102 precheck: 098 instalada (098+102 exige revisão conjunta)';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'agenda_saloes'
              AND column_name IN ('convidados_minimo', 'convidados_sentados', 'area_m2', 'idade_min', 'idade_max', 'frase',
                                  'outra_festa_simultanea', 'exclusivos', 'fotos_referencia', 'declaracao_em', 'declaracao_por',
                                  'declaracao_versao', 'conteudo_versao'))
    OR to_regclass('public.agenda_salao_itens_catalogo') IS NOT NULL OR to_regclass('public.agenda_salao_itens') IS NOT NULL
    OR to_regclass('public.agenda_salao_fotos') IS NOT NULL
    OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname LIKE 'kidmais102\_%') THEN
    RAISE EXCEPTION '102 precheck: 102 já aplicada ou parcial';
  END IF;
END $$;
