-- Postcheck de instalação inicial do cadastro. Somente leitura.
-- A contagem zero de revisões não deve ser reutilizada depois do primeiro rascunho.
-- Este arquivo não foi executado.
DO $$ BEGIN
  IF to_regclass('public.perfil_empresa_revisoes') IS NULL THEN
    RAISE EXCEPTION '027: revisões ausentes';
  END IF;
  IF (SELECT count(*) FROM public.perfil_empresa_revisoes) <> 0 THEN
    RAISE EXCEPTION '027: zero revisões vale só na instalação inicial';
  END IF;
  IF (
    SELECT count(*) FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'perfil_empresas'
      AND column_name IN ('nome_comercial', 'razao_social', 'cnpj', 'versao', 'sede_sem_numero')
  ) <> 5 THEN
    RAISE EXCEPTION '027: colunas da empresa ausentes';
  END IF;
  IF (
    SELECT count(*) FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'perfil_unidades'
      AND column_name IN ('nome', 'mesmo_endereco_sede', 'sem_numero', 'telefone', 'email_comercial')
  ) <> 5 THEN
    RAISE EXCEPTION '027: colunas da unidade ausentes';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_index
    WHERE indexrelid = 'public.perfil_empresa_rascunho_uk'::regclass
      AND indrelid = 'public.perfil_empresa_revisoes'::regclass
      AND indisunique
      AND pg_get_expr(indpred, indrelid) = '(estado = ''RASCUNHO''::text)'
  ) THEN
    RAISE EXCEPTION '027: unicidade do rascunho ausente';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    WHERE i.indrelid = 'public.perfil_empresas'::regclass
      AND i.indisunique
      AND pg_get_expr(i.indpred, i.indrelid) IS NULL
      AND c.relname NOT IN ('perfil_empresas_pkey', 'perfil_empresas_codigo_uk')
  ) THEN
    RAISE EXCEPTION '027: índice único global inesperado';
  END IF;
END $$;
