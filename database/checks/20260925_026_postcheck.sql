-- Postcheck de instalação inicial. Somente leitura desta verificação.
-- Vale apenas no momento em que as três tabelas acabaram de ser criadas vazias.
-- Não reutilizar após o provisionamento: a primeira empresa, a unidade e as
-- concessões passam a existir de propósito. Rodar este arquivo de novo falharia
-- de forma esperada e não indica regressão.
-- Este arquivo não foi executado. A leitura estática não prova o catálogo.
DO $$ BEGIN
  IF to_regclass('public.perfil_empresas') IS NULL
     OR to_regclass('public.perfil_unidades') IS NULL
     OR to_regclass('public.perfil_empresa_concessoes') IS NULL THEN
    RAISE EXCEPTION '026: tabela ausente';
  END IF;
  IF (SELECT count(*) FROM public.perfil_empresas) <> 0
     OR (SELECT count(*) FROM public.perfil_unidades) <> 0
     OR (SELECT count(*) FROM public.perfil_empresa_concessoes) <> 0 THEN
    RAISE EXCEPTION '026: zero linhas vale só na instalação inicial';
  END IF;
  IF (
    SELECT count(*)
    FROM (VALUES
      ('perfil_empresas', 'id', 'uuid', 'NO'),
      ('perfil_empresas', 'codigo', 'text', 'NO'),
      ('perfil_empresas', 'criado_em', 'timestamp with time zone', 'NO'),
      ('perfil_unidades', 'id', 'uuid', 'NO'),
      ('perfil_unidades', 'empresa_id', 'uuid', 'NO'),
      ('perfil_unidades', 'codigo', 'text', 'NO'),
      ('perfil_unidades', 'criado_em', 'timestamp with time zone', 'NO'),
      ('perfil_empresa_concessoes', 'id', 'uuid', 'NO'),
      ('perfil_empresa_concessoes', 'empresa_id', 'uuid', 'NO'),
      ('perfil_empresa_concessoes', 'usuario_id', 'uuid', 'NO'),
      ('perfil_empresa_concessoes', 'capacidade', 'text', 'NO'),
      ('perfil_empresa_concessoes', 'concedido_por', 'uuid', 'NO'),
      ('perfil_empresa_concessoes', 'concedido_em', 'timestamp with time zone', 'NO'),
      ('perfil_empresa_concessoes', 'motivo', 'text', 'NO'),
      ('perfil_empresa_concessoes', 'referencia_autorizacao', 'text', 'NO'),
      ('perfil_empresa_concessoes', 'revogado_por', 'uuid', 'YES'),
      ('perfil_empresa_concessoes', 'revogado_em', 'timestamp with time zone', 'YES'),
      ('perfil_empresa_concessoes', 'motivo_revogacao', 'text', 'YES')
    ) AS e(tabela, coluna, tipo, nulo)
    WHERE EXISTS (
      SELECT 1 FROM information_schema.columns c
      WHERE c.table_schema = 'public'
        AND c.table_name = e.tabela
        AND c.column_name = e.coluna
        AND c.data_type = e.tipo
        AND c.is_nullable = e.nulo
    )
  ) <> 18 THEN
    RAISE EXCEPTION '026: coluna essencial ausente ou divergente';
  END IF;
  IF (
    SELECT count(*)
    FROM (VALUES
      ('perfil_empresas_pkey', 'perfil_empresas'),
      ('perfil_unidades_pkey', 'perfil_unidades'),
      ('perfil_empresa_concessoes_pkey', 'perfil_empresa_concessoes')
    ) AS e(nome, tabela)
    WHERE EXISTS (
      SELECT 1
      FROM pg_constraint c
      WHERE c.conname = e.nome
        AND c.connamespace = 'public'::regnamespace
        AND c.contype = 'p'
        AND c.conrelid = format('public.%I', e.tabela)::regclass
        AND c.convalidated
        AND (
          SELECT array_agg(a.attname ORDER BY k.ord)
          FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
          JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
        ) = ARRAY['id']::name[]
    )
  ) <> 3 THEN
    RAISE EXCEPTION '026: chave primária ausente';
  END IF;
  IF (
    SELECT count(*)
    FROM pg_constraint c
    WHERE c.connamespace = 'public'::regnamespace
      AND c.contype = 'f'
      AND c.conrelid IN (
        'public.perfil_empresas'::regclass,
        'public.perfil_unidades'::regclass,
        'public.perfil_empresa_concessoes'::regclass
      )
  ) <> 5
  OR (
    SELECT count(*)
    FROM (VALUES
      ('perfil_unidades_empresa_fk', 'perfil_unidades', 'empresa_id', 'perfil_empresas', 'id'),
      ('perfil_empresa_concessoes_empresa_fk', 'perfil_empresa_concessoes', 'empresa_id', 'perfil_empresas', 'id'),
      ('perfil_empresa_concessoes_usuario_fk', 'perfil_empresa_concessoes', 'usuario_id', 'usuarios_administrativos', 'id'),
      ('perfil_empresa_concessoes_concedido_por_fk', 'perfil_empresa_concessoes', 'concedido_por', 'usuarios_administrativos', 'id'),
      ('perfil_empresa_concessoes_revogado_por_fk', 'perfil_empresa_concessoes', 'revogado_por', 'usuarios_administrativos', 'id')
    ) AS e(nome, tabela, coluna, referencia, coluna_ref)
    WHERE EXISTS (
      SELECT 1
      FROM pg_constraint c
      WHERE c.conname = e.nome
        AND c.connamespace = 'public'::regnamespace
        AND c.contype = 'f'
        AND c.conrelid = format('public.%I', e.tabela)::regclass
        AND c.confrelid = format('public.%I', e.referencia)::regclass
        AND c.confdeltype = 'r'
        AND c.confupdtype = 'r'
        AND c.convalidated
        AND (
          SELECT array_agg(a.attname ORDER BY k.ord)
          FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
          JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
        ) = ARRAY[e.coluna]::name[]
        AND (
          SELECT array_agg(a.attname ORDER BY k.ord)
          FROM unnest(c.confkey) WITH ORDINALITY AS k(attnum, ord)
          JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum
        ) = ARRAY[e.coluna_ref]::name[]
    )
  ) <> 5 THEN
    RAISE EXCEPTION '026: FK ausente, referência divergente ou ação diferente de RESTRICT';
  END IF;
  IF (
    SELECT count(*)
    FROM pg_constraint c
    WHERE c.connamespace = 'public'::regnamespace
      AND c.contype = 'c'
      AND c.conrelid IN (
        'public.perfil_empresas'::regclass,
        'public.perfil_unidades'::regclass,
        'public.perfil_empresa_concessoes'::regclass
      )
  ) <> 6
  OR (
    SELECT count(*)
    FROM (VALUES
      ('perfil_empresas_codigo_check', 'perfil_empresas'),
      ('perfil_unidades_codigo_check', 'perfil_unidades'),
      ('perfil_empresa_concessoes_capacidade_check', 'perfil_empresa_concessoes'),
      ('perfil_empresa_concessoes_motivo_check', 'perfil_empresa_concessoes'),
      ('perfil_empresa_concessoes_referencia_check', 'perfil_empresa_concessoes'),
      ('perfil_empresa_concessoes_revogacao_check', 'perfil_empresa_concessoes')
    ) AS e(nome, tabela)
    WHERE EXISTS (
      SELECT 1
      FROM pg_constraint c
      WHERE c.conname = e.nome
        AND c.connamespace = 'public'::regnamespace
        AND c.contype = 'c'
        AND c.conrelid = format('public.%I', e.tabela)::regclass
        AND c.convalidated
        AND CASE e.nome
          WHEN 'perfil_empresas_codigo_check' THEN
            strpos(pg_get_constraintdef(c.oid), 'codigo = btrim(codigo)') > 0
            AND strpos(pg_get_constraintdef(c.oid), 'length(codigo)') > 0
          WHEN 'perfil_unidades_codigo_check' THEN
            strpos(pg_get_constraintdef(c.oid), 'codigo = btrim(codigo)') > 0
            AND strpos(pg_get_constraintdef(c.oid), 'length(codigo)') > 0
          WHEN 'perfil_empresa_concessoes_capacidade_check' THEN
            strpos(pg_get_constraintdef(c.oid), 'PERFIL_CONSULTAR') > 0
            AND strpos(pg_get_constraintdef(c.oid), 'PERFIL_EDITAR_RASCUNHO') > 0
            AND strpos(pg_get_constraintdef(c.oid), 'PERFIL_APLICAR') > 0
            AND strpos(pg_get_constraintdef(c.oid), 'PERFIL_ADMINISTRAR_CONCESSOES') > 0
          WHEN 'perfil_empresa_concessoes_motivo_check' THEN
            strpos(pg_get_constraintdef(c.oid), 'btrim(motivo)') > 0
          WHEN 'perfil_empresa_concessoes_referencia_check' THEN
            strpos(pg_get_constraintdef(c.oid), 'btrim(referencia_autorizacao)') > 0
          WHEN 'perfil_empresa_concessoes_revogacao_check' THEN
            strpos(pg_get_constraintdef(c.oid), 'revogado_por IS NULL') > 0
            AND strpos(pg_get_constraintdef(c.oid), 'revogado_em IS NULL') > 0
            AND strpos(pg_get_constraintdef(c.oid), 'motivo_revogacao IS NULL') > 0
            AND strpos(pg_get_constraintdef(c.oid), 'revogado_por IS NOT NULL') > 0
            AND strpos(pg_get_constraintdef(c.oid), 'revogado_em IS NOT NULL') > 0
            AND strpos(pg_get_constraintdef(c.oid), 'motivo_revogacao IS NOT NULL') > 0
            AND strpos(pg_get_constraintdef(c.oid), 'btrim(motivo_revogacao)') > 0
          ELSE false
        END
    )
  ) <> 6 THEN
    RAISE EXCEPTION '026: CHECK esperado ausente';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_index i
    WHERE i.indexrelid = 'public.perfil_empresa_concessao_ativa_uk'::regclass
      AND i.indrelid = 'public.perfil_empresa_concessoes'::regclass
      AND i.indisunique
      AND i.indisvalid
      AND i.indisready
      AND pg_get_expr(i.indpred, i.indrelid) = '(revogado_em IS NULL)'
      AND (
        SELECT array_agg(a.attname ORDER BY k.ord)
        FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
      ) = ARRAY['empresa_id', 'usuario_id', 'capacidade']::name[]
  ) THEN
    RAISE EXCEPTION '026: índice parcial da capacidade ativa ausente';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    WHERE i.indrelid IN (
      'public.perfil_empresas'::regclass,
      'public.perfil_unidades'::regclass,
      'public.perfil_empresa_concessoes'::regclass
    )
      AND pg_get_expr(i.indpred, i.indrelid) IS NULL
      AND i.indisunique
      AND c.relname NOT IN (
        'perfil_empresas_pkey',
        'perfil_unidades_pkey',
        'perfil_empresa_concessoes_pkey',
        'perfil_empresas_codigo_uk',
        'perfil_unidades_codigo_uk'
      )
  ) THEN
    RAISE EXCEPTION '026: índice único global inesperado';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'usuarios_administrativos'
      AND column_name LIKE 'perfil\_%' ESCAPE '\'
  ) THEN
    RAISE EXCEPTION '026: usuarios_administrativos foi alterado';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.festa_usuario_capacidades'::regclass
      AND pg_get_constraintdef(oid) ~ 'PERFIL_'
  ) THEN
    RAISE EXCEPTION '026: capacidades de Festa alteradas';
  END IF;
END $$;
