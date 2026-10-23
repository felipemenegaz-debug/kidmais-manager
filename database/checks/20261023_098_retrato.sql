-- Somente leitura. Retrato estrutural CANÔNICO dos objetos de que a 093/094/098 dependem (rodadas 4 e 5 do Astra,
-- P2-1): o mesmo texto entra no precheck (estado 094), no postcheck e no verificador (estado 098) e no rollback (098
-- antes, 094 depois), entre os marcadores @@RETRATO-INICIO/@@RETRATO-FIM, e é comparado por SHA-256.
-- Escopo:
--  * funções protegidas: kidmais019/061/062/093/094/098_*, kidmais_validar_agenda_revisao, kidmais_lock_datas_revisao,
--    kidmais_ocupacoes_operacionais, kidmais_proteger_bloqueio_revisao e as funções de gatilho das tabelas-base;
--  * tabelas: as oito tabelas-base (agenda_saloes, fechamentos, fechamento_revisoes, contratos, contrato_fluxos, festas,
--    pacote_saloes, configuracao_agenda_saloes) e TODA tabela ou view de public cujo nome aparece no corpo de uma função
--    protegida (dependências diretas: configuracao_agenda, agenda_escopo_config, bloqueios_agenda, habilitação da 062,
--    formalização, importação…), com as funções de gatilho dessas tabelas também;
--  * FECHAMENTO TRANSITIVO (rodada 6 do Astra): função → tabelas/views e funções de public citadas no corpo; tabela →
--    funções dos gatilhos; view → tabelas citadas; até não haver nada novo;
--  * sequências das colunas do escopo, tipos não internos das colunas e extensões que fornecem os defaults (presença).
-- Entra: tabelas (tipo, persistência, RLS), colunas (tipo, nulidade, default por expressão, identity, gerada,
-- collation), constraints das tabelas do escopo e as que apontam para elas (definição, validação, adiamento), índices
-- (definição e validade), gatilhos de usuário (definição e estado), gatilhos INTERNOS das constraints — FK nos dois
-- lados — identificados por constraint, tabelas, função, eventos, estado e adiamento (sem o nome, que traz OID),
-- regras, políticas (com os papéis) e atributos das funções (corpo, linguagem, volatilidade, SECURITY DEFINER, STRICT, LEAKPROOF,
-- PARALLEL, SET (search_path), retorno e argumentos).
-- Fica fora o que muda por ambiente: dono, ACL e OIDs (dono e privilégios têm checagens próprias no verificador).
-- Calculado com search_path = pg_catalog (o texto das definições depende do search_path) e ordenado em collation "C".
-- Vale para o inventário até a 098 em PostgreSQL 18: migration nova que toque estes objetos exige recalcular os
-- retratos esperados, depois de investigar a divergência.
-- Uso para diagnóstico (diff entre ambientes): rodar este arquivo e comparar a coluna "retrato".
BEGIN READ ONLY;
SET LOCAL search_path = pg_catalog;
SELECT
-- @@RETRATO-INICIO
(WITH RECURSIVE dep(tipo, oid) AS (
  -- Raízes: as oito tabelas-base e as funções protegidas.
  SELECT 'r'::text, c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = ANY (ARRAY['agenda_saloes', 'fechamentos', 'fechamento_revisoes', 'contratos', 'contrato_fluxos',
         'festas', 'pacote_saloes', 'configuracao_agenda_saloes'])
  UNION
  SELECT 'f'::text, p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND (p.proname ~ '^kidmais(019|061|062|093|094|098)_'
          OR p.proname IN ('kidmais_validar_agenda_revisao', 'kidmais_lock_datas_revisao', 'kidmais_ocupacoes_operacionais', 'kidmais_proteger_bloqueio_revisao'))
  UNION
  -- Fechamento transitivo (rodada 6 do Astra): função → tabelas/views e funções de public citadas no corpo;
  -- tabela → funções dos seus gatilhos de usuário; view → tabelas/views citadas na definição.
  SELECT x.tipo, x.oid FROM dep d CROSS JOIN LATERAL (
    SELECT 'r'::text AS tipo, c.oid FROM pg_proc p, pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE d.tipo = 'f' AND p.oid = d.oid AND n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
       AND p.prosrc ~ ('\m' || c.relname || '\M')
    UNION ALL
    SELECT 'f'::text, q.oid FROM pg_proc p, pg_proc q JOIN pg_namespace n ON n.oid = q.pronamespace
     WHERE d.tipo = 'f' AND p.oid = d.oid AND n.nspname = 'public' AND p.prosrc ~ ('\m' || q.proname || '\M')
    UNION ALL
    SELECT 'f'::text, t.tgfoid FROM pg_trigger t WHERE d.tipo = 'r' AND t.tgrelid = d.oid AND NOT t.tgisinternal
    UNION ALL
    SELECT 'r'::text, c.oid FROM pg_class v, pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE d.tipo = 'r' AND v.oid = d.oid AND v.relkind IN ('v', 'm') AND n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
       AND pg_get_viewdef(v.oid) ~ ('\m' || c.relname || '\M')
  ) x
), escopo AS (
  SELECT oid FROM dep WHERE tipo = 'r'
), funcoes AS (
  SELECT oid FROM dep WHERE tipo = 'f'
), sequencias AS (
  -- Sequências das colunas do escopo: identity/serial (dependência da tabela) e as usadas por defaults (nextval).
  SELECT DISTINCT dd.objid AS oid, dd.refobjid AS tabela, dd.refobjsubid AS coluna
    FROM pg_depend dd JOIN pg_class s ON s.oid = dd.objid AND s.relkind = 'S'
   WHERE dd.classid = 'pg_class'::regclass AND dd.refclassid = 'pg_class'::regclass AND dd.deptype IN ('a', 'i')
     AND dd.refobjid IN (SELECT oid FROM escopo)
  UNION
  SELECT DISTINCT dd.refobjid, ad.adrelid, ad.adnum
    FROM pg_attrdef ad JOIN pg_depend dd ON dd.classid = 'pg_attrdef'::regclass AND dd.objid = ad.oid AND dd.refclassid = 'pg_class'::regclass
    JOIN pg_class s ON s.oid = dd.refobjid AND s.relkind = 'S'
   WHERE ad.adrelid IN (SELECT oid FROM escopo)
), tipos AS (
  -- Tipos não internos usados pelas colunas do escopo (domínios, enums, compostos, ranges), com o tipo-elemento de arrays.
  SELECT DISTINCT ty.oid FROM pg_attribute a
    JOIN pg_type t0 ON t0.oid = a.atttypid
    JOIN pg_type ty ON ty.oid = CASE WHEN t0.typelem <> 0 AND t0.typcategory = 'A' THEN t0.typelem ELSE t0.oid END
    JOIN pg_namespace tn ON tn.oid = ty.typnamespace
   WHERE a.attrelid IN (SELECT oid FROM escopo) AND a.attnum > 0 AND NOT a.attisdropped
     AND (tn.nspname NOT IN ('pg_catalog', 'information_schema') OR ty.typtype IN ('d', 'e', 'c', 'r', 'm'))
)
SELECT string_agg(l, E'\n' ORDER BY l COLLATE "C") FROM (
  SELECT 'T|' || c.relname || '|' || c.relkind::text || '|' || c.relpersistence::text || '|' || c.relrowsecurity || '|' || c.relforcerowsecurity AS l
    FROM pg_class c WHERE c.oid IN (SELECT oid FROM escopo)
  UNION ALL
  SELECT 'C|' || c.relname || '|' || a.attname || '|' || format_type(a.atttypid, a.atttypmod) || '|' || a.attnotnull || '|'
         || coalesce(pg_get_expr(d.adbin, d.adrelid), '') || '|' || a.attidentity::text || '|' || a.attgenerated::text || '|' || coalesce(co.collname, '')
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    LEFT JOIN pg_collation co ON co.oid = a.attcollation AND a.attcollation <> 0
   WHERE a.attnum > 0 AND NOT a.attisdropped AND c.oid IN (SELECT oid FROM escopo)
  UNION ALL
  SELECT 'K|' || c.relname || '|' || k.conname || '|' || k.contype::text || '|' || pg_get_constraintdef(k.oid) || '|' || k.convalidated || '|'
         || k.condeferrable || '|' || k.condeferred
    FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid
   WHERE k.conrelid IN (SELECT oid FROM escopo) OR k.confrelid IN (SELECT oid FROM escopo)
  UNION ALL
  SELECT 'I|' || c.relname || '|' || ic.relname || '|' || pg_get_indexdef(i.indexrelid) || '|' || i.indisvalid || '|' || i.indisready
    FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid JOIN pg_class ic ON ic.oid = i.indexrelid
   WHERE c.oid IN (SELECT oid FROM escopo)
  UNION ALL
  SELECT 'G|' || c.relname || '|' || t.tgname || '|' || pg_get_triggerdef(t.oid) || '|' || t.tgenabled::text
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
   WHERE NOT t.tgisinternal AND c.oid IN (SELECT oid FROM escopo)
  UNION ALL
  SELECT 'GI|' || c.relname || '|' || k.conname || '|' || kc.relname || '|' || coalesce(kf.relname, '') || '|' || p.proname || '|' || t.tgtype
         || '|' || t.tgenabled::text || '|' || t.tgdeferrable || '|' || t.tginitdeferred
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_constraint k ON k.oid = t.tgconstraint
    JOIN pg_class kc ON kc.oid = k.conrelid LEFT JOIN pg_class kf ON kf.oid = k.confrelid JOIN pg_proc p ON p.oid = t.tgfoid
   WHERE t.tgisinternal AND (k.conrelid IN (SELECT oid FROM escopo) OR k.confrelid IN (SELECT oid FROM escopo))
  UNION ALL
  SELECT 'R|' || c.relname || '|' || r.rulename || '|' || pg_get_ruledef(r.oid)
    FROM pg_rewrite r JOIN pg_class c ON c.oid = r.ev_class
   WHERE c.oid IN (SELECT oid FROM escopo)
  UNION ALL
  SELECT 'P|' || c.relname || '|' || p.polname || '|' || p.polcmd::text || '|' || p.polpermissive || '|'
         || coalesce((SELECT string_agg(CASE WHEN r = 0 THEN 'public' ELSE pg_get_userbyid(r)::text END, ',' ORDER BY 1) FROM unnest(p.polroles) AS u(r)), '') || '|'
         || coalesce(pg_get_expr(p.polqual, p.polrelid), '')
         || '|' || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')
    FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
   WHERE c.oid IN (SELECT oid FROM escopo)
  UNION ALL
  SELECT 'F|' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')|' || p.prokind::text || '|' || l.lanname || '|'
         || pg_get_function_result(p.oid) || '|' || p.provolatile::text || '|' || p.prosecdef || '|' || p.proisstrict || '|' || p.proleakproof || '|'
         || p.proparallel::text || '|' || coalesce(array_to_string(p.proconfig, ';'), '') || '|'
         || encode(sha256(convert_to(replace(p.prosrc, E'\r', ''), 'UTF8')), 'hex')
    FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
   WHERE p.oid IN (SELECT oid FROM funcoes)
  UNION ALL
  SELECT 'S|' || c.relname || '|' || coalesce(a.attname, '') || '|' || s.relname || '|' || format_type(q.seqtypid, NULL) || '|' || q.seqstart || '|'
         || q.seqincrement || '|' || q.seqmin || '|' || q.seqmax || '|' || q.seqcache || '|' || q.seqcycle
    FROM sequencias sq JOIN pg_class s ON s.oid = sq.oid JOIN pg_sequence q ON q.seqrelid = sq.oid JOIN pg_class c ON c.oid = sq.tabela
    LEFT JOIN pg_attribute a ON a.attrelid = sq.tabela AND a.attnum = sq.coluna
  UNION ALL
  SELECT 'Y|' || tn.nspname || '.' || ty.typname || '|' || ty.typtype::text || '|'
         || CASE ty.typtype
              WHEN 'd' THEN format_type(ty.typbasetype, ty.typtypmod) || '|' || ty.typnotnull || '|' || coalesce(ty.typdefault, '') || '|'
                            || coalesce((SELECT string_agg(k.conname || ':' || pg_get_constraintdef(k.oid), ';' ORDER BY k.conname COLLATE "C")
                                           FROM pg_constraint k WHERE k.contypid = ty.oid), '')
              WHEN 'e' THEN coalesce((SELECT string_agg(e.enumlabel, ';' ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid = ty.oid), '')
              WHEN 'c' THEN coalesce((SELECT string_agg(ca.attname || ':' || format_type(ca.atttypid, ca.atttypmod), ';' ORDER BY ca.attnum)
                                        FROM pg_attribute ca WHERE ca.attrelid = ty.typrelid AND ca.attnum > 0 AND NOT ca.attisdropped), '')
              WHEN 'r' THEN coalesce((SELECT format_type(r.rngsubtype, NULL) FROM pg_range r WHERE r.rngtypid = ty.oid), '')
              ELSE '' END
    FROM tipos tp JOIN pg_type ty ON ty.oid = tp.oid JOIN pg_namespace tn ON tn.oid = ty.typnamespace
  UNION ALL
  -- Extensões que fornecem funções usadas nos defaults do escopo (pgcrypto/gen_random_uuid): só a presença; versão e
  -- configuração são pré-requisito do ambiente, documentado à parte.
  SELECT DISTINCT 'X|' || x.extname
    FROM pg_attrdef ad
    JOIN pg_depend df ON df.classid = 'pg_attrdef'::regclass AND df.objid = ad.oid AND df.refclassid = 'pg_proc'::regclass
    JOIN pg_depend de ON de.classid = 'pg_proc'::regclass AND de.objid = df.refobjid AND de.refclassid = 'pg_extension'::regclass AND de.deptype = 'e'
    JOIN pg_extension x ON x.oid = de.refobjid
   WHERE ad.adrelid IN (SELECT oid FROM escopo)
) AS linhas)
-- @@RETRATO-FIM
  AS retrato;
COMMIT;
