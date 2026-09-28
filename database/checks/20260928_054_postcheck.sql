-- Somente leitura. Confere a 054 pelo catálogo e pelo dado, a qualquer momento depois da
-- aplicação (validação operacional):
--   dependências (mesmo bloco kidmais-054-dependencias da migration e do precheck);
--   colunas (uuid, nulas, sem default); FKs (RESTRICT, validadas, não diferíveis);
--   gatilhos da 054 (schema, tabela, função, eventos, colunas, ENABLED, sem WHEN, gatilho comum);
--   funções da 054 (search_path fixo, nenhuma SECURITY DEFINER);
--   critério operacional (kidmais_054_falhar_se_incompativel) e índice global de CPF intacto.
-- A prova do backfill imediato (NULL esperado inclusive) fica em 20260928_054_backfill_imediato.sql.
DO $$
DECLARE
  divergentes text;
  divergencias text;
BEGIN
  -- kidmais-054-dependencias:inicio
  -- Mesmo bloco no precheck e no postcheck. tgtype: ROW=1, BEFORE=2, INSERT=4, DELETE=8, UPDATE=16;
  -- AFTER não tem bit. restricao = gatilho de restrição DEFERRABLE INITIALLY DEFERRED.
  SELECT string_agg(e.gatilho, ', ' ORDER BY e.gatilho) INTO divergentes
    FROM (VALUES
      ('pacotes_empresa_imutavel_trg', 'pacotes', 'public.kidmais_036_empresa_pai_imutavel()', 19, ARRAY['empresa_id'], false),
      ('tabelas_preco_empresa_imutavel_trg', 'tabelas_preco', 'public.kidmais_036_empresa_pai_imutavel()', 19, ARRAY['empresa_id'], false),
      ('adicionais_empresa_imutavel_trg', 'adicionais', 'public.kidmais_036_empresa_pai_imutavel()', 19, ARRAY['empresa_id'], false),
      ('fechamentos_053_empresa_trg', 'fechamentos', 'public.kidmais_053_fechamento()', 23, ARRAY['pacote_id', 'preco_pacote_id', 'regra_desconto_pacote_id', 'tabela_preco_id'], false),
      ('fechamentos_053_filhos_trg', 'fechamentos', 'public.kidmais_053_fechamento_filhos()', 17, ARRAY['pacote_id', 'tabela_preco_id'], true),
      ('fechamento_adicionais_053_empresa_trg', 'fechamento_adicionais', 'public.kidmais_053_fechamento_adicional()', 23, ARRAY['adicional_id', 'fechamento_id', 'preco_adicional_id'], false),
      ('fechamento_revisoes_053_empresa_trg', 'fechamento_revisoes', 'public.kidmais_053_revisao()', 23, ARRAY['fechamento_id', 'pacote_id', 'preco_pacote_id', 'regra_desconto_pacote_id', 'tabela_preco_id'], false),
      ('fechamento_revisoes_053_filhos_trg', 'fechamento_revisoes', 'public.kidmais_053_revisao_filhos()', 17, ARRAY['pacote_id', 'tabela_preco_id'], true),
      ('fechamento_revisao_adicionais_053_empresa_trg', 'fechamento_revisao_adicionais', 'public.kidmais_053_revisao_adicional()', 23, ARRAY['adicional_id', 'fechamento_revisao_id', 'preco_adicional_id'], false),
      ('fechamento_pacote_snapshots_053_empresa_trg', 'fechamento_pacote_snapshots', 'public.kidmais_053_fotografia()', 7, ARRAY[]::text[], false),
      ('fechamento_pacote_composicao_053_empresa_trg', 'fechamento_pacote_composicao', 'public.kidmais_053_composicao()', 7, ARRAY[]::text[], false),
      ('regras_desconto_pacote_053_utilizada_trg', 'regras_desconto_pacote', 'public.kidmais_053_desconto_utilizado()', 19, ARRAY['pacote_id'], false),
      ('clientes_atualizado_em_trg', 'clientes', 'public.kidmais_set_atualizado_em()', 19, ARRAY[]::text[], false),
      ('fechamentos_atualizado_em_trg', 'fechamentos', 'public.kidmais_set_atualizado_em()', 19, ARRAY[]::text[], false),
      -- Guardas históricas sobre fechamentos que o SET CONSTRAINTS ALL IMMEDIATE do backfill
      -- executa (014: fr_*; 019: festa019_*). A 054 só as exige; nunca as desliga nem recria.
      ('fr_fechamento_proteger_trg', 'fechamentos', 'public.kidmais_proteger_fechamento_em_revisao()', 17, ARRAY[]::text[], true),
      ('fr_confirmacao_agenda_trg', 'fechamentos', 'public.kidmais_validar_agenda_revisao()', 21, ARRAY[]::text[], true),
      ('festa019_fechamento', 'fechamentos', 'public.kidmais019_validar_contrato()', 21, ARRAY[]::text[], true),
      ('festa019_lock_fechamento', 'fechamentos', 'public.kidmais019_lock_ocupacao()', 23, ARRAY[]::text[], false)
    ) AS e(gatilho, tabela, funcao, tipo, colunas, restricao)
   WHERE NOT EXISTS (
     SELECT 1
       FROM pg_catalog.pg_trigger t
       JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE NOT t.tgisinternal AND t.tgname = e.gatilho AND c.relname = e.tabela AND n.nspname = 'public'
        AND t.tgfoid = to_regprocedure(e.funcao) AND t.tgtype = e.tipo AND t.tgenabled = 'O'
        AND t.tgqual IS NULL
        AND (t.tgconstraint <> 0) = e.restricao
        AND t.tgdeferrable = e.restricao
        AND t.tginitdeferred = e.restricao
        AND ARRAY(SELECT a.attname::text FROM unnest(t.tgattr::int2[]) AS k(num)
                    JOIN pg_catalog.pg_attribute a ON a.attrelid = t.tgrelid AND a.attnum = k.num
                   ORDER BY a.attname) = e.colunas
   );
  IF divergentes IS NOT NULL THEN
    RAISE EXCEPTION '054: dependência ausente ou degradada: %.', divergentes;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conname = 'fechamento_pacote_snapshots_anterior_mesmo_fechamento_fk'
       AND conrelid = to_regclass('public.fechamento_pacote_snapshots')
       AND contype = 'f' AND convalidated
  ) OR (SELECT count(*) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname LIKE 'kidmais\_053\_%'
           AND p.proconfig @> ARRAY['search_path=pg_catalog, pg_temp'] AND NOT p.prosecdef) <> 15 THEN
    RAISE EXCEPTION '054: instalação da 053 incompleta (FK da fotografia ou funções).';
  END IF;
  -- kidmais-054-dependencias:fim

  -- Colunas.
  SELECT string_agg(e.tabela, ', ' ORDER BY e.tabela) INTO divergencias
    FROM (VALUES ('clientes'), ('fechamentos')) AS e(tabela)
   WHERE NOT EXISTS (
     SELECT 1
       FROM pg_catalog.pg_attribute a
       JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = e.tabela
        AND a.attname = 'empresa_id' AND NOT a.attisdropped
        AND a.atttypid = 'uuid'::regtype
        AND NOT a.attnotnull
        AND NOT a.atthasdef
   );
  IF divergencias IS NOT NULL THEN
    RAISE EXCEPTION '054 postcheck: coluna empresa_id ausente ou divergente: %.', divergencias;
  END IF;

  -- Chaves estrangeiras.
  SELECT string_agg(e.nome, ', ' ORDER BY e.nome) INTO divergencias
    FROM (VALUES ('clientes_054_empresa_fk', 'clientes'), ('fechamentos_054_empresa_fk', 'fechamentos')) AS e(nome, tabela)
   WHERE NOT EXISTS (
     SELECT 1
       FROM pg_catalog.pg_constraint k
      WHERE k.conname = e.nome
        AND k.contype = 'f'
        AND k.conrelid = ('public.' || e.tabela)::regclass
        AND k.confrelid = 'public.empresas'::regclass
        AND k.convalidated
        AND NOT k.condeferrable
        AND k.confupdtype = 'r'
        AND k.confdeltype = 'r'
        AND k.confmatchtype = 's'
        AND ARRAY(SELECT a.attname::text FROM unnest(k.conkey) AS x(num)
                    JOIN pg_catalog.pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = x.num) = ARRAY['empresa_id']
        AND ARRAY(SELECT a.attname::text FROM unnest(k.confkey) AS x(num)
                    JOIN pg_catalog.pg_attribute a ON a.attrelid = k.confrelid AND a.attnum = x.num) = ARRAY['id']
   );
  IF divergencias IS NOT NULL THEN
    RAISE EXCEPTION '054 postcheck: chave estrangeira ausente ou divergente: %.', divergencias;
  END IF;

  -- Gatilhos da 054. tgtype: ROW=1, BEFORE=2, INSERT=4, UPDATE=16.
  SELECT string_agg(e.gatilho, ', ' ORDER BY e.gatilho) INTO divergencias
    FROM (VALUES
      ('clientes_054_empresa_imutavel_trg', 'clientes', 'public.kidmais_054_empresa_imutavel()', 19, ARRAY['empresa_id']),
      ('fechamentos_054_empresa_imutavel_trg', 'fechamentos', 'public.kidmais_054_empresa_imutavel()', 19, ARRAY['empresa_id']),
      ('fechamentos_054_empresa_coerente_trg', 'fechamentos', 'public.kidmais_054_fechamento_empresa_coerente()', 23, ARRAY['empresa_id', 'pacote_id']),
      ('fechamentos_054_cliente_coerente_trg', 'fechamentos', 'public.kidmais_054_fechamento_cliente_coerente()', 23, ARRAY['cliente_id']),
      ('fechamento_revisoes_054_cliente_coerente_trg', 'fechamento_revisoes', 'public.kidmais_054_revisao_cliente_coerente()', 23, ARRAY['cliente_id', 'fechamento_id'])
    ) AS e(gatilho, tabela, funcao, tipo, colunas)
   WHERE NOT EXISTS (
     SELECT 1
       FROM pg_catalog.pg_trigger t
       JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE NOT t.tgisinternal AND t.tgname = e.gatilho AND c.relname = e.tabela AND n.nspname = 'public'
        AND t.tgfoid = to_regprocedure(e.funcao) AND t.tgtype = e.tipo AND t.tgenabled = 'O'
        AND t.tgqual IS NULL AND t.tgconstraint = 0 AND NOT t.tgdeferrable
        AND ARRAY(SELECT a.attname::text FROM unnest(t.tgattr::int2[]) AS k(num)
                    JOIN pg_catalog.pg_attribute a ON a.attrelid = t.tgrelid AND a.attnum = k.num
                   ORDER BY a.attname) = e.colunas
   );
  IF divergencias IS NOT NULL THEN
    RAISE EXCEPTION '054 postcheck: gatilho ausente ou divergente: %.', divergencias;
  END IF;

  -- Funções.
  IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname LIKE 'kidmais\_054\_%'
         AND p.proconfig @> ARRAY['search_path=pg_catalog, pg_temp']
         AND NOT p.prosecdef) <> 5
     OR (SELECT count(*) FROM pg_catalog.pg_proc WHERE proname LIKE 'kidmais\_054\_%') <> 5 THEN
    RAISE EXCEPTION '054 postcheck: funções da 054 ausentes, sem search_path fixo ou SECURITY DEFINER.';
  END IF;

  -- CPF continua com unicidade global nesta etapa (PR-B2 muda).
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_index i
     WHERE i.indexrelid = to_regclass('public.clientes_cpf_canonico_uk')
       AND i.indrelid = 'public.clientes'::regclass
       AND i.indisunique
       AND i.indnatts = 1
       AND (SELECT a.attname FROM pg_catalog.pg_attribute a WHERE a.attrelid = i.indrelid AND a.attnum = i.indkey[0]) = 'cpf'
       AND pg_catalog.pg_get_expr(i.indpred, i.indrelid) LIKE '%MESCLADO%'
  ) THEN
    RAISE EXCEPTION '054 postcheck: clientes_cpf_canonico_uk ausente ou alterado.';
  END IF;

  PERFORM public.kidmais_054_falhar_se_incompativel();
END $$;

SELECT 'pos_054' AS marco,
  (SELECT count(*) FROM public.clientes) AS clientes_total,
  (SELECT count(*) FROM public.fechamentos) AS fechamentos_total,
  (SELECT count(*) FROM public.clientes WHERE empresa_id IS NOT NULL) AS clientes_com_empresa,
  (SELECT count(*) FROM public.clientes WHERE empresa_id IS NULL) AS clientes_sem_empresa,
  (SELECT count(*) FROM public.fechamentos WHERE empresa_id IS NOT NULL) AS fechamentos_com_empresa,
  (SELECT count(*) FROM public.fechamentos WHERE empresa_id IS NULL) AS fechamentos_sem_empresa,
  (SELECT md5(coalesce(string_agg((to_jsonb(c) - 'empresa_id')::text, ',' ORDER BY c.id), '')) FROM public.clientes c) AS clientes_hash,
  (SELECT md5(coalesce(string_agg((to_jsonb(f) - 'empresa_id')::text, ',' ORDER BY f.id), '')) FROM public.fechamentos f) AS fechamentos_hash;
