-- Somente leitura. A migration 054 repete estes critérios: dependências antes de criar qualquer
-- objeto (mesmo bloco kidmais-054-dependencias) e ambiguidade depois de travar as tabelas.
-- Não corrige, não apaga e não atribui empresa. Falha aqui impede a aplicação.
-- O SELECT final registra a simulação do backfill e a contagem/hash para o postcheck.
DO $$
DECLARE
  divergentes text;
  ambiguos text;
  n_ambiguos bigint;
BEGIN
  IF to_regclass('public.clientes') IS NULL
     OR to_regclass('public.fechamentos') IS NULL
     OR to_regclass('public.fechamento_revisoes') IS NULL
     OR to_regclass('public.pacotes') IS NULL
     OR to_regclass('public.empresas') IS NULL THEN
    RAISE EXCEPTION '054 precheck: clientes, fechamentos, revisões, pacotes ou empresas ausente.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'pacotes' AND column_name = 'empresa_id'
  ) THEN
    RAISE EXCEPTION '054 precheck: pacotes.empresa_id ausente.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name IN ('clientes', 'fechamentos') AND column_name = 'empresa_id'
  ) OR to_regprocedure('public.kidmais_054_falhar_se_incompativel()') IS NOT NULL THEN
    RAISE EXCEPTION '054 precheck: a 054 já está instalada.';
  END IF;

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

  WITH grupo AS (
    SELECT c.id AS cliente_id,
           CASE WHEN c.status = 'MESCLADO' THEN c.cliente_principal_id ELSE c.id END AS canonico_id
      FROM public.clientes c
  )
  SELECT string_agg(t.canonico_id::text, ', ' ORDER BY t.canonico_id), count(*)
    INTO ambiguos, n_ambiguos
    FROM (
      SELECT g.canonico_id
        FROM grupo g
        JOIN public.fechamentos f ON f.cliente_id = g.cliente_id
        JOIN public.pacotes p ON p.id = f.pacote_id
       WHERE p.empresa_id IS NOT NULL
       GROUP BY g.canonico_id
      HAVING count(DISTINCT p.empresa_id) > 1
    ) t;
  IF ambiguos IS NOT NULL THEN
    RAISE EXCEPTION '054 precheck: % grupo(s) canônico(s) com fechamentos em empresas distintas: %. Não corrigir daqui.',
      n_ambiguos, ambiguos;
  END IF;
END $$;

-- Simulação do backfill: por cliente, quantas empresas comprovadas o grupo canônico tem
-- (0 -> ficará NULL; 1 -> receberá essa empresa). O postcheck imprime o mesmo hash sem
-- empresa_id: os dois coincidem se nada mais escreveu nas tabelas entre um e outro.
WITH grupo AS (
  SELECT c.id AS cliente_id,
         CASE WHEN c.status = 'MESCLADO' THEN c.cliente_principal_id ELSE c.id END AS canonico_id
    FROM public.clientes c
), derivada AS (
  SELECT g.canonico_id, count(DISTINCT p.empresa_id) AS empresas
    FROM grupo g
    JOIN public.fechamentos f ON f.cliente_id = g.cliente_id
    JOIN public.pacotes p ON p.id = f.pacote_id
   WHERE p.empresa_id IS NOT NULL
   GROUP BY g.canonico_id
)
SELECT 'pre_054' AS marco,
  (SELECT count(*) FROM public.clientes) AS clientes_total,
  (SELECT count(*) FROM public.fechamentos) AS fechamentos_total,
  (SELECT count(*) FROM grupo g JOIN derivada d ON d.canonico_id = g.canonico_id WHERE d.empresas = 1) AS clientes_receberao_empresa,
  (SELECT count(*) FROM grupo g LEFT JOIN derivada d ON d.canonico_id = g.canonico_id WHERE d.canonico_id IS NULL) AS clientes_permanecerao_sem_empresa,
  (SELECT count(*) FROM public.fechamentos f JOIN public.pacotes p ON p.id = f.pacote_id WHERE p.empresa_id IS NOT NULL)
    AS fechamentos_receberao_empresa,
  (SELECT count(*) FROM public.fechamentos f JOIN public.pacotes p ON p.id = f.pacote_id WHERE p.empresa_id IS NULL)
    AS fechamentos_pacote_legado,
  (SELECT md5(coalesce(string_agg(to_jsonb(c)::text, ',' ORDER BY c.id), '')) FROM public.clientes c) AS clientes_hash,
  (SELECT md5(coalesce(string_agg(to_jsonb(f)::text, ',' ORDER BY f.id), '')) FROM public.fechamentos f) AS fechamentos_hash;
