-- Sonda somente leitura do preflight RC1 para o Shell do kidmais-manager-staging.
-- Colar este texto no psql. O arquivo ainda não existe no host implantado.
-- Só SELECT / WITH. Sem INSERT, UPDATE, DELETE, DDL, DO ou tabela temporária.
-- Cada sentença é independente. Relação ausente gera erro só nela e não grava nada.
-- Imprime contagens, impressões digitais e booleanos. Não lista senha nem linhas completas.

SELECT current_database() AS banco,
       inet_server_port() AS porta,
       current_setting('server_version') AS versao_postgres;

-- Impressão digital das migrations. Presença de objeto não prova que o arquivo inteiro rodou.
WITH objetos(marco, kind, nome) AS (
  VALUES
    ('026', 'rel', 'perfil_empresas'),
    ('027', 'rel', 'perfil_empresa_revisoes'),
    ('028', 'col', 'perfil_empresa_revisoes.aplicado_por'),
    ('029', 'rel', 'fechamento_pacote_snapshots'),
    ('029', 'rel', 'fechamento_pacote_composicao'),
    ('029', 'proc', 'kidmais_029_fotografia_imutavel()'),
    ('030', 'proc', 'kidmais_030_preco_utilizado()'),
    ('031', 'rel', 'empresas'),
    ('031', 'proc', 'kidmais_031_guard_empresas()'),
    ('032', 'idx', 'pacotes_empresa_codigo_vigente_uk'),
    ('033', 'col', 'tabelas_preco.publicada_em'),
    ('034', 'proc', 'kidmais_034_recusar_empresa_distinta(uuid,uuid,text)'),
    ('035', 'proc', 'kidmais_035_preservar_tabela_publicada()'),
    ('036', 'proc', 'kidmais_036_empresa_pai_imutavel()'),
    ('037', 'proc', 'kidmais_037_trava_publicacao(uuid)'),
    ('038', 'proc', 'kidmais_038_falhar_se_incompativel()'),
    ('039', 'proc', 'kidmais_039_travar_par(uuid,uuid)'),
    ('040', 'proc', 'kidmais_040_falhar_se_incompativel()'),
    ('041', 'proc', 'kidmais_041_revisao_mesmo_tenant()'),
    ('042', 'proc', 'kidmais_042_falhar_se_faixa_publicada_sobreposta()'),
    ('043', 'rel', 'estabelecimentos'),
    ('043', 'rel', 'memberships'),
    ('044', 'proc', 'kidmais_044_guard_empresas()'),
    ('045', 'proc', 'kidmais_045_guard_memberships()'),
    ('047', 'rel', 'tabela_preco_escopos')
)
SELECT o.marco,
       o.kind,
       o.nome,
       CASE o.kind
         WHEN 'rel' THEN to_regclass('public.' || o.nome) IS NOT NULL
         WHEN 'idx' THEN to_regclass('public.' || o.nome) IS NOT NULL
         WHEN 'proc' THEN to_regprocedure('public.' || o.nome) IS NOT NULL
         WHEN 'col' THEN EXISTS (
           SELECT 1
             FROM information_schema.columns c
            WHERE c.table_schema = 'public'
              AND c.table_name = split_part(o.nome, '.', 1)
              AND c.column_name = split_part(o.nome, '.', 2)
         )
       END AS presente
  FROM objetos o
 ORDER BY o.marco, o.nome;

-- Contagem estatística. n_live_tup pode atrasar em relação ao count(*).
SELECT s.relname,
       s.n_live_tup
  FROM pg_stat_user_tables s
 WHERE s.schemaname = 'public'
   AND s.relname IN (
     'pacotes', 'precos_pacote', 'tabelas_preco', 'adicionais', 'pacote_adicionais',
     'fechamentos', 'fechamento_pacote_snapshots', 'fechamento_pacote_composicao',
     'contratos', 'contrato_versoes', 'contrato_assinaturas', 'festas', 'pagamentos',
     'empresas', 'memberships', 'perfil_empresas', 'perfil_empresa_revisoes'
   )
 ORDER BY s.relname;

-- Identidade autorizada: só id, papel, ativo e a quantidade de correspondências.
SELECT id,
       papel,
       ativo,
       count(*) OVER () AS correspondencias
  FROM usuarios_administrativos
 WHERE lower(btrim(email)) = lower(btrim('felipemenegaz@gmail.com'));

SELECT count(*)::bigint AS correspondencias_email
  FROM usuarios_administrativos
 WHERE lower(btrim(email)) = lower(btrim('felipemenegaz@gmail.com'));

SELECT count(*)::bigint AS pacotes,
       count(*) FILTER (WHERE codigo = 'FESTA_LOCAL')::bigint AS festa_local,
       count(*) FILTER (WHERE codigo IN (
         'COMPACTA', 'COMPLETA', 'ESSENCIAL', 'MINI_FESTA', 'PIZZA_PARTY', 'POCKET', 'PREMIUM'
       ))::bigint AS sete_oficiais
  FROM pacotes;

SELECT codigo,
       count(*)::bigint AS linhas
  FROM pacotes
 WHERE codigo IN (
   'COMPACTA', 'COMPLETA', 'ESSENCIAL', 'MINI_FESTA', 'PIZZA_PARTY', 'POCKET', 'PREMIUM', 'FESTA_LOCAL'
 )
 GROUP BY codigo
 ORDER BY codigo;

SELECT count(*)::bigint AS precos_pacote FROM precos_pacote;
SELECT count(*)::bigint AS tabelas_preco FROM tabelas_preco;
SELECT count(*)::bigint AS contratos FROM contratos;
SELECT count(*)::bigint AS contrato_versoes FROM contrato_versoes;
SELECT count(*)::bigint AS contrato_assinaturas FROM contrato_assinaturas;
SELECT count(*)::bigint AS fechamentos FROM fechamentos;
SELECT count(*)::bigint AS festas FROM festas;
SELECT count(*)::bigint AS pagamentos FROM pagamentos;

SELECT count(*)::bigint AS snapshots
  FROM fechamento_pacote_snapshots;
SELECT count(*)::bigint AS composicao
  FROM fechamento_pacote_composicao;

-- Precheck 040, só leitura. Exige as colunas empresa_id da 031.
SELECT to_regclass('public.precos_pacote') IS NOT NULL
   AND to_regclass('public.pacote_adicionais') IS NOT NULL
   AND to_regclass('public.precos_adicional') IS NOT NULL AS catalogo_040_presente,
       NOT EXISTS (
         SELECT 1
           FROM precos_pacote pp
           JOIN tabelas_preco t ON t.id = pp.tabela_preco_id
           JOIN pacotes p ON p.id = pp.pacote_id
          WHERE t.empresa_id IS DISTINCT FROM p.empresa_id
       ) AS precos_pacote_mesma_empresa,
       NOT EXISTS (
         SELECT 1
           FROM precos_adicional pr
           JOIN tabelas_preco t ON t.id = pr.tabela_preco_id
           JOIN adicionais a ON a.id = pr.adicional_id
          WHERE t.empresa_id IS DISTINCT FROM a.empresa_id
       ) AS precos_adicional_mesma_empresa,
       NOT EXISTS (
         SELECT 1
           FROM pacote_adicionais pa
           JOIN pacotes p ON p.id = pa.pacote_id
           JOIN adicionais a ON a.id = pa.adicional_id
          WHERE p.empresa_id IS DISTINCT FROM a.empresa_id
       ) AS pacote_adicional_mesma_empresa;

-- Precheck 046, só leitura. Não cria a empresa nem altera o usuário.
SELECT to_regclass('public.empresas') IS NOT NULL
   AND to_regclass('public.memberships') IS NOT NULL
   AND to_regclass('public.usuarios_administrativos') IS NOT NULL
   AND to_regprocedure('public.kidmais_036_empresa_pai_imutavel()') IS NOT NULL
   AND to_regprocedure('public.kidmais_044_guard_empresas()') IS NOT NULL
   AND to_regprocedure('public.kidmais_045_guard_memberships()') IS NOT NULL AS fundacao_046_presente,
       to_regprocedure('public.kidmais_040_falhar_se_incompativel()') IS NOT NULL AS guarda_040_presente,
       EXISTS (SELECT 1 FROM empresas WHERE codigo = 'kidmais') AS empresa_kidmais_existe;

SELECT COALESCE((
         SELECT array_agg(p.codigo::text ORDER BY p.codigo)
           FROM pacotes p
          WHERE p.empresa_id IS NULL
       ), ARRAY[]::text[])
       IS NOT DISTINCT FROM
       ARRAY['COMPACTA','COMPLETA','ESSENCIAL','MINI_FESTA','PIZZA_PARTY','POCKET','PREMIUM']::text[]
       AS conjunto_nulo_e_os_sete;

SELECT EXISTS (
         SELECT 1
           FROM pacote_adicionais pa
           JOIN pacotes p ON p.id = pa.pacote_id
           JOIN adicionais a ON a.id = pa.adicional_id
          WHERE a.id IN (
            SELECT pa2.adicional_id
              FROM pacote_adicionais pa2
              JOIN pacotes p2 ON p2.id = pa2.pacote_id
             WHERE p2.codigo = ANY (ARRAY['COMPACTA','COMPLETA','ESSENCIAL','MINI_FESTA','PIZZA_PARTY','POCKET','PREMIUM'])
          )
            AND p.codigo <> ALL (ARRAY['COMPACTA','COMPLETA','ESSENCIAL','MINI_FESTA','PIZZA_PARTY','POCKET','PREMIUM'])
       ) AS vinculo_fora_dos_sete;

SELECT EXISTS (
         SELECT 1
           FROM pacote_adicionais pa
           JOIN pacotes p ON p.id = pa.pacote_id
           JOIN adicionais a ON a.id = pa.adicional_id
          WHERE p.codigo = 'PREMIUM'
            AND a.codigo = 'SALADA_PREMIUM'
            AND pa.modalidade = 'INCLUSO'
            AND p.empresa_id IS NULL
            AND a.empresa_id IS NULL
       ) AS salada_premium_inclusa_oficial;
