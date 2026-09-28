-- Somente leitura. Confere a instalação da 053 pelo catálogo, não por nome:
-- tabela e schema de cada gatilho, função chamada, eventos (tgtype), colunas de UPDATE OF,
-- estado ENABLED, ausência de cláusula WHEN, diferimento dos gatilhos de restrição, a chave
-- estrangeira composta, o search_path fixo das funções e as dependências 030, 034 e 036/038
-- (empresa imutável) e 029 (fotografia imutável), todas pelo mesmo critério; ações e diferimento
-- da FK; nenhuma função SECURITY DEFINER. Repete o critério do histórico.
DO $$
DECLARE
  divergencias text;
BEGIN
  -- tgtype: ROW=1, BEFORE=2, INSERT=4, UPDATE=16. AFTER não tem bit.
  WITH esperado(gatilho, tabela, funcao, tipo, colunas, restricao) AS (
    VALUES
      ('fechamentos_053_empresa_trg', 'fechamentos', 'public.kidmais_053_fechamento()', 23,
        ARRAY['pacote_id', 'preco_pacote_id', 'regra_desconto_pacote_id', 'tabela_preco_id'], false),
      ('fechamentos_053_filhos_trg', 'fechamentos', 'public.kidmais_053_fechamento_filhos()', 17,
        ARRAY['pacote_id', 'tabela_preco_id'], true),
      ('fechamento_adicionais_053_empresa_trg', 'fechamento_adicionais', 'public.kidmais_053_fechamento_adicional()', 23,
        ARRAY['adicional_id', 'fechamento_id', 'preco_adicional_id'], false),
      ('fechamento_revisoes_053_empresa_trg', 'fechamento_revisoes', 'public.kidmais_053_revisao()', 23,
        ARRAY['fechamento_id', 'pacote_id', 'preco_pacote_id', 'regra_desconto_pacote_id', 'tabela_preco_id'], false),
      ('fechamento_revisoes_053_filhos_trg', 'fechamento_revisoes', 'public.kidmais_053_revisao_filhos()', 17,
        ARRAY['pacote_id', 'tabela_preco_id'], true),
      ('fechamento_revisao_adicionais_053_empresa_trg', 'fechamento_revisao_adicionais', 'public.kidmais_053_revisao_adicional()', 23,
        ARRAY['adicional_id', 'fechamento_revisao_id', 'preco_adicional_id'], false),
      ('fechamento_pacote_snapshots_053_empresa_trg', 'fechamento_pacote_snapshots', 'public.kidmais_053_fotografia()', 7,
        ARRAY[]::text[], false),
      ('fechamento_pacote_composicao_053_empresa_trg', 'fechamento_pacote_composicao', 'public.kidmais_053_composicao()', 7,
        ARRAY[]::text[], false),
      ('regras_desconto_pacote_053_utilizada_trg', 'regras_desconto_pacote', 'public.kidmais_053_desconto_utilizado()', 19,
        ARRAY['pacote_id'], false),
      -- Dependências: 030 (preço utilizado) e 034 (tenant do catálogo) ligadas.
      ('precos_pacote_calculo_utilizado_trg', 'precos_pacote', 'public.kidmais_030_preco_utilizado()', 19,
        ARRAY[]::text[], false),
      ('precos_adicional_calculo_utilizado_trg', 'precos_adicional', 'public.kidmais_030_preco_utilizado()', 19,
        ARRAY[]::text[], false),
      ('precos_pacote_empresa_trg', 'precos_pacote', 'public.kidmais_034_precos_pacote_empresa()', 23,
        ARRAY['pacote_id', 'tabela_preco_id'], false),
      ('precos_adicional_empresa_trg', 'precos_adicional', 'public.kidmais_034_precos_adicional_empresa()', 23,
        ARRAY['adicional_id', 'tabela_preco_id'], false),
      ('pacote_adicionais_empresa_trg', 'pacote_adicionais', 'public.kidmais_034_pacote_adicionais_empresa()', 23,
        ARRAY['adicional_id', 'pacote_id'], false),
      -- Dependências: empresa imutável em pacote, tabela e adicional (036/038).
      ('pacotes_empresa_imutavel_trg', 'pacotes', 'public.kidmais_036_empresa_pai_imutavel()', 19,
        ARRAY['empresa_id'], false),
      ('tabelas_preco_empresa_imutavel_trg', 'tabelas_preco', 'public.kidmais_036_empresa_pai_imutavel()', 19,
        ARRAY['empresa_id'], false),
      ('adicionais_empresa_imutavel_trg', 'adicionais', 'public.kidmais_036_empresa_pai_imutavel()', 19,
        ARRAY['empresa_id'], false),
      -- Dependências: fotografia e composição imutáveis (029). tgtype 27 = ROW + BEFORE + DELETE + UPDATE.
      ('fechamento_pacote_snapshots_imutavel', 'fechamento_pacote_snapshots', 'public.kidmais_029_fotografia_imutavel()', 27,
        ARRAY[]::text[], false),
      ('fechamento_pacote_composicao_imutavel', 'fechamento_pacote_composicao', 'public.kidmais_029_fotografia_imutavel()', 27,
        ARRAY[]::text[], false)
  ), instalado AS (
    SELECT t.tgname::text AS gatilho, c.relname::text AS tabela, n.nspname::text AS esquema, t.tgfoid, t.tgtype::int AS tipo,
           t.tgenabled, t.tgconstraint <> 0 AS restricao, t.tgdeferrable, t.tginitdeferred, t.tgqual IS NULL AS sem_when,
           ARRAY(
             SELECT a.attname::text
               FROM unnest(t.tgattr::int2[]) AS k(num)
               JOIN pg_catalog.pg_attribute a ON a.attrelid = t.tgrelid AND a.attnum = k.num
              ORDER BY a.attname
           ) AS colunas
      FROM pg_catalog.pg_trigger t
      JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE NOT t.tgisinternal
  )
  SELECT string_agg(e.gatilho, ', ' ORDER BY e.gatilho) INTO divergencias
    FROM esperado e
    LEFT JOIN instalado i
      ON i.gatilho = e.gatilho
     AND i.tabela = e.tabela
     AND i.esquema = 'public'
     AND i.tgfoid = to_regprocedure(e.funcao)
     AND i.tipo = e.tipo
     AND i.tgenabled = 'O'
     AND i.colunas = e.colunas
     AND i.restricao = e.restricao
     AND i.tgdeferrable = e.restricao
     AND i.tginitdeferred = e.restricao
     AND i.sem_when
   WHERE i.gatilho IS NULL;
  IF divergencias IS NOT NULL THEN
    RAISE EXCEPTION '053 postcheck: gatilho ausente ou divergente: %.', divergencias;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_constraint k
     WHERE k.conname = 'fechamento_pacote_snapshots_anterior_mesmo_fechamento_fk'
       AND k.contype = 'f'
       AND k.convalidated
       AND NOT k.condeferrable
       AND k.confupdtype = 'r'
       AND k.confdeltype = 'r'
       AND k.confmatchtype = 's'
       AND k.conrelid = 'public.fechamento_pacote_snapshots'::regclass
       AND k.confrelid = 'public.fechamento_pacote_snapshots'::regclass
       AND ARRAY(SELECT a.attname::text FROM unnest(k.conkey) WITH ORDINALITY AS x(num, ord)
                   JOIN pg_catalog.pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = x.num ORDER BY x.ord)
           = ARRAY['snapshot_anterior_id', 'fechamento_id']
       AND ARRAY(SELECT a.attname::text FROM unnest(k.confkey) WITH ORDINALITY AS x(num, ord)
                   JOIN pg_catalog.pg_attribute a ON a.attrelid = k.confrelid AND a.attnum = x.num ORDER BY x.ord)
           = ARRAY['id', 'fechamento_id']
  ) THEN
    RAISE EXCEPTION '053 postcheck: chave estrangeira composta da fotografia anterior ausente ou divergente.';
  END IF;

  IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname LIKE 'kidmais\_053\_%'
         AND p.proconfig @> ARRAY['search_path=pg_catalog, pg_temp']
         AND NOT p.prosecdef) <> 15
     OR (SELECT count(*) FROM pg_catalog.pg_proc WHERE proname LIKE 'kidmais\_053\_%') <> 15 THEN
    RAISE EXCEPTION '053 postcheck: funções da 053 ausentes, sem search_path fixo ou SECURITY DEFINER.';
  END IF;

  PERFORM public.kidmais_053_falhar_se_incompativel();
END $$;
SELECT 'pos_053' AS marco,
  (SELECT count(*) FROM fechamentos f JOIN pacotes p ON p.id = f.pacote_id WHERE p.empresa_id IS NULL)
    AS fechamentos_legado_sem_empresa;
