-- Somente leitura. A migration 053 repete este critério depois de travar as tabelas.
-- Não há lista branca. Não corrige, não apaga e não associa fechamento a empresa.
-- Falha aqui impede a aplicação. A mensagem traz a contagem por tabela para localizar a origem.
DO $$
DECLARE
  fechamentos_n bigint;
  adicionais_n bigint;
  revisoes_n bigint;
  adicionais_revisao_n bigint;
  fotografias_n bigint;
  composicoes_n bigint;
  anteriores_n bigint;
  divergentes text;
BEGIN
  IF to_regclass('public.fechamentos') IS NULL
     OR to_regclass('public.fechamento_adicionais') IS NULL
     OR to_regclass('public.fechamento_revisoes') IS NULL
     OR to_regclass('public.fechamento_revisao_adicionais') IS NULL
     OR to_regclass('public.fechamento_pacote_snapshots') IS NULL
     OR to_regclass('public.fechamento_pacote_composicao') IS NULL
     OR to_regclass('public.regras_desconto_pacote') IS NULL THEN
    RAISE EXCEPTION '053 precheck: fechamento ou catálogo comercial ausente.';
  END IF;
  IF to_regprocedure('public.kidmais_034_recusar_empresa_distinta(uuid,uuid,text)') IS NULL THEN
    RAISE EXCEPTION '053 precheck: guarda 034 ausente.';
  END IF;
  IF to_regprocedure('public.kidmais_030_preco_utilizado()') IS NULL THEN
    RAISE EXCEPTION '053 precheck: proteção de preço utilizado (030) ausente.';
  END IF;
  -- Dependências 029, 030, 034 e 036/038: mesmo critério da migration e do postcheck.
  SELECT string_agg(e.gatilho, ', ' ORDER BY e.gatilho) INTO divergentes
    FROM (VALUES
      ('fechamento_pacote_snapshots_imutavel', 'fechamento_pacote_snapshots', 'public.kidmais_029_fotografia_imutavel()', 27, ARRAY[]::text[]),
      ('fechamento_pacote_composicao_imutavel', 'fechamento_pacote_composicao', 'public.kidmais_029_fotografia_imutavel()', 27, ARRAY[]::text[]),
      ('precos_pacote_calculo_utilizado_trg', 'precos_pacote', 'public.kidmais_030_preco_utilizado()', 19, ARRAY[]::text[]),
      ('precos_adicional_calculo_utilizado_trg', 'precos_adicional', 'public.kidmais_030_preco_utilizado()', 19, ARRAY[]::text[]),
      ('precos_pacote_empresa_trg', 'precos_pacote', 'public.kidmais_034_precos_pacote_empresa()', 23, ARRAY['pacote_id', 'tabela_preco_id']),
      ('precos_adicional_empresa_trg', 'precos_adicional', 'public.kidmais_034_precos_adicional_empresa()', 23, ARRAY['adicional_id', 'tabela_preco_id']),
      ('pacote_adicionais_empresa_trg', 'pacote_adicionais', 'public.kidmais_034_pacote_adicionais_empresa()', 23, ARRAY['adicional_id', 'pacote_id']),
      ('pacotes_empresa_imutavel_trg', 'pacotes', 'public.kidmais_036_empresa_pai_imutavel()', 19, ARRAY['empresa_id']),
      ('tabelas_preco_empresa_imutavel_trg', 'tabelas_preco', 'public.kidmais_036_empresa_pai_imutavel()', 19, ARRAY['empresa_id']),
      ('adicionais_empresa_imutavel_trg', 'adicionais', 'public.kidmais_036_empresa_pai_imutavel()', 19, ARRAY['empresa_id'])
    ) AS e(gatilho, tabela, funcao, tipo, colunas)
   WHERE NOT EXISTS (
     SELECT 1
       FROM pg_catalog.pg_trigger t
       JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE NOT t.tgisinternal AND t.tgname = e.gatilho AND c.relname = e.tabela AND n.nspname = 'public'
        AND t.tgfoid = to_regprocedure(e.funcao) AND t.tgtype = e.tipo AND t.tgenabled = 'O'
        AND t.tgqual IS NULL AND t.tgconstraint = 0
        AND ARRAY(SELECT a.attname::text FROM unnest(t.tgattr::int2[]) AS k(num)
                    JOIN pg_catalog.pg_attribute a ON a.attrelid = t.tgrelid AND a.attnum = k.num
                   ORDER BY a.attname) = e.colunas
   );
  IF divergentes IS NOT NULL THEN
    RAISE EXCEPTION '053 precheck: dependência ausente ou degradada: %.', divergentes;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conrelid = 'public.fechamento_pacote_snapshots'::regclass
       AND conname = 'fechamento_pacote_snapshots_id_fechamento_uk'
       AND contype = 'u'
  ) THEN
    RAISE EXCEPTION '053 precheck: chave (id, fechamento_id) da fotografia ausente.';
  END IF;
  IF to_regprocedure('public.kidmais_053_falhar_se_incompativel()') IS NOT NULL THEN
    RAISE EXCEPTION '053 precheck: a 053 já está instalada.';
  END IF;

  SELECT count(*) INTO fechamentos_n
    FROM fechamentos f
    JOIN pacotes p ON p.id = f.pacote_id
    JOIN tabelas_preco t ON t.id = f.tabela_preco_id
    LEFT JOIN precos_pacote pp
      ON pp.id = f.preco_pacote_id AND pp.pacote_id = f.pacote_id AND pp.tabela_preco_id = f.tabela_preco_id
    LEFT JOIN regras_desconto_pacote r
      ON r.id = f.regra_desconto_pacote_id AND r.pacote_id = f.pacote_id
   WHERE t.empresa_id IS DISTINCT FROM p.empresa_id
      OR pp.id IS NULL
      OR (f.regra_desconto_pacote_id IS NOT NULL AND r.id IS NULL);

  SELECT count(*) INTO adicionais_n
    FROM fechamento_adicionais fa
    JOIN fechamentos f ON f.id = fa.fechamento_id
    JOIN pacotes p ON p.id = f.pacote_id
    JOIN adicionais a ON a.id = fa.adicional_id
    LEFT JOIN precos_adicional pa
      ON pa.id = fa.preco_adicional_id AND pa.adicional_id = fa.adicional_id AND pa.tabela_preco_id = f.tabela_preco_id
   WHERE a.empresa_id IS DISTINCT FROM p.empresa_id
      OR pa.id IS NULL;

  SELECT count(*) INTO revisoes_n
    FROM fechamento_revisoes rv
    JOIN fechamentos f ON f.id = rv.fechamento_id
    JOIN pacotes pf ON pf.id = f.pacote_id
    JOIN pacotes p ON p.id = rv.pacote_id
    JOIN tabelas_preco t ON t.id = rv.tabela_preco_id
    LEFT JOIN precos_pacote pp
      ON pp.id = rv.preco_pacote_id AND pp.pacote_id = rv.pacote_id AND pp.tabela_preco_id = rv.tabela_preco_id
    LEFT JOIN regras_desconto_pacote r
      ON r.id = rv.regra_desconto_pacote_id AND r.pacote_id = rv.pacote_id
   WHERE t.empresa_id IS DISTINCT FROM p.empresa_id
      OR p.empresa_id IS DISTINCT FROM pf.empresa_id
      OR pp.id IS NULL
      OR (rv.regra_desconto_pacote_id IS NOT NULL AND r.id IS NULL);

  SELECT count(*) INTO adicionais_revisao_n
    FROM fechamento_revisao_adicionais ra
    JOIN fechamento_revisoes rv ON rv.id = ra.fechamento_revisao_id
    JOIN pacotes p ON p.id = rv.pacote_id
    JOIN adicionais a ON a.id = ra.adicional_id
    LEFT JOIN precos_adicional pa
      ON pa.id = ra.preco_adicional_id AND pa.adicional_id = ra.adicional_id AND pa.tabela_preco_id = rv.tabela_preco_id
   WHERE a.empresa_id IS DISTINCT FROM p.empresa_id
      OR pa.id IS NULL;

  SELECT count(*) INTO fotografias_n
    FROM fechamento_pacote_snapshots s
    JOIN fechamentos f ON f.id = s.fechamento_id
    JOIN pacotes pf ON pf.id = f.pacote_id
    JOIN pacotes p ON p.id = s.pacote_id
    JOIN tabelas_preco t ON t.id = s.tabela_preco_id
    LEFT JOIN precos_pacote pp
      ON pp.id = s.preco_pacote_id AND pp.pacote_id = s.pacote_id AND pp.tabela_preco_id = s.tabela_preco_id
    LEFT JOIN regras_desconto_pacote r
      ON r.id = s.regra_desconto_pacote_id AND r.pacote_id = s.pacote_id
   WHERE t.empresa_id IS DISTINCT FROM p.empresa_id
      OR p.empresa_id IS DISTINCT FROM pf.empresa_id
      OR pp.id IS NULL
      OR (s.regra_desconto_pacote_id IS NOT NULL AND r.id IS NULL);

  SELECT count(*) INTO composicoes_n
    FROM fechamento_pacote_composicao c
    JOIN fechamento_pacote_snapshots s ON s.id = c.snapshot_id
    JOIN pacotes p ON p.id = s.pacote_id
    JOIN adicionais a ON a.id = c.adicional_id
   WHERE a.empresa_id IS DISTINCT FROM p.empresa_id;

  -- A chave estrangeira composta da 053 exige a fotografia anterior no mesmo fechamento.
  SELECT count(*) INTO anteriores_n
    FROM fechamento_pacote_snapshots s
    JOIN fechamento_pacote_snapshots anterior ON anterior.id = s.snapshot_anterior_id
   WHERE anterior.fechamento_id <> s.fechamento_id;

  IF fechamentos_n + adicionais_n + revisoes_n + adicionais_revisao_n + fotografias_n + composicoes_n + anteriores_n > 0 THEN
    RAISE EXCEPTION '053 precheck: fechamento incompatível (fechamentos=%, adicionais=%, revisões=%, adicionais de revisão=%, fotografias=%, composições=%, fotografias anteriores de outro fechamento=%). Não corrigir daqui.',
      fechamentos_n, adicionais_n, revisoes_n, adicionais_revisao_n, fotografias_n, composicoes_n, anteriores_n;
  END IF;
END $$;

SELECT 'pre_053' AS marco,
  (SELECT count(*) FROM fechamentos f JOIN pacotes p ON p.id = f.pacote_id WHERE p.empresa_id IS NULL)
    AS fechamentos_legado_sem_empresa;
