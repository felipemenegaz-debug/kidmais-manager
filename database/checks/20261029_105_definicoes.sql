-- Integridade REFORÇADA da 105 (somente leitura, só catálogo): inventário das DEFINIÇÕES dos objetos da 105, uma linha
-- (chave, definicao) por objeto, para o aplicador comparar com o inventário esperado (scripts/migration-105-definicoes.cjs),
-- sem faltar nem sobrar. Plano MCP produção pré-requisitos, rev. 3, P1 (P2-3 do Astra): a integridade antiga
-- (20261027_105_integridade.sql) compara sobretudo nomes e contagens; aqui entram:
--   * tabelas: tipo, persistência, opções, herança, tipagem, REPLICA IDENTITY, RLS/FORCE RLS, políticas, RULEs e dono
--     igual ao de public.empresas (o papel dono da aplicação);
--   * colunas: posição, tipo (format_type), nulidade, DEFAULT (pg_get_expr), identidade, gerada e collation explícita;
--   * restrições (PK, UNIQUE, CHECK, FK; NOT NULL do PG18 fica fora, já coberta pela nulidade): pg_get_constraintdef,
--     validada e "enforced" (PG18; ausente = true);
--   * índices: pg_get_indexdef, inclusive o predicado parcial, e as flags de chave/validade;
--   * gatilhos não internos: pg_get_triggerdef e tgenabled; internos nas seis tabelas: quantos estão FORA do modo
--     normal 'O' (desabilitado 'D', só réplica 'R' ou sempre 'A'; esperado 0);
--   * gatilhos de cada FK da 105, pelo tgconstraint, NOS DOIS LADOS (inclusive empresas e usuarios_administrativos):
--     tabela, função RI_FKey_*, tgtype e tgenabled (revisão do Astra, rodada 1, P2-1);
--   * funções public.mcp_oauth_concessao_revogacao_imutavel (todas as sobrecargas): sha256 do corpo e atributos;
--   * public.gen_random_uuid() (homônimo do pg_catalog que o DEFAULT das chaves resolve primeiro com o search_path da
--     migration): ausente, ou a função GENUÍNA do pgcrypto (membro da extensão, C, símbolo pg_random_uuid) — rodada 1, P2-2.
-- O CHAMADOR fixa `search_path = pg_catalog, pg_temp` e `IntervalStyle = postgres` (o deparse qualifica public.* e o
-- intervalo sai em formato fixo, sem depender da sessão). Tabelas resolvidas SEMPRE por nome qualificado public.<t>.
WITH t(nome) AS (VALUES ('mcp_oauth_clientes'), ('mcp_oauth_pedidos'), ('mcp_oauth_concessoes'), ('mcp_oauth_codigos'),
    ('mcp_oauth_tokens'), ('mcp_auditoria')),
  r AS (SELECT t.nome, c.* FROM t JOIN pg_class c ON c.oid = to_regclass('public.' || t.nome)),
  dono AS (SELECT relowner FROM pg_class WHERE oid = to_regclass('public.empresas'))
SELECT chave, definicao FROM (
  SELECT 'tabela:' || r.nome AS chave,
    concat_ws('|', 'tipo=' || r.relkind::text, 'persistencia=' || r.relpersistence::text, 'opcoes=' || coalesce(array_to_string(r.reloptions, ','), ''),
      'tipada=' || (r.reloftype <> 0)::text, 'particao=' || r.relispartition::text, 'replica=' || r.relreplident::text,
      'heranca=' || (SELECT count(*) FROM pg_inherits i WHERE i.inhrelid = r.oid OR i.inhparent = r.oid)::text,
      'rls=' || r.relrowsecurity::text, 'forcar_rls=' || r.relforcerowsecurity::text,
      'politicas=' || (SELECT count(*) FROM pg_policy p WHERE p.polrelid = r.oid)::text,
      'regras=' || (SELECT count(*) FROM pg_rewrite w WHERE w.ev_class = r.oid)::text,
      'dono_da_aplicacao=' || (r.relowner = (SELECT relowner FROM dono))::text) AS definicao
  FROM r
  UNION ALL
  SELECT 'coluna:' || r.nome || '.' || a.attname,
    concat_ws('|', a.attnum, format_type(a.atttypid, a.atttypmod), CASE WHEN a.attnotnull THEN 'NOT NULL' ELSE 'NULL' END,
      'default=' || coalesce(pg_get_expr(d.adbin, d.adrelid), ''), 'identidade=' || a.attidentity::text, 'gerada=' || a.attgenerated::text,
      'collation=' || CASE WHEN a.attcollation = ty.typcollation THEN '' ELSE coalesce((SELECT collname FROM pg_collation WHERE oid = a.attcollation), '?') END)
  FROM r JOIN pg_attribute a ON a.attrelid = r.oid AND a.attnum > 0 AND NOT a.attisdropped
    JOIN pg_type ty ON ty.oid = a.atttypid
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  UNION ALL
  SELECT 'restricao:' || r.nome || '.' || k.conname,
    concat_ws('|', k.contype::text, pg_get_constraintdef(k.oid), 'validada=' || k.convalidated::text,
      'aplicada=' || coalesce((to_jsonb(k) ->> 'conenforced')::boolean, true)::text)
  FROM r JOIN pg_constraint k ON k.conrelid = r.oid AND k.contype <> 'n'
  UNION ALL
  SELECT 'indice:' || r.nome || '.' || ic.relname,
    concat_ws('|', pg_get_indexdef(i.indexrelid), 'unico=' || i.indisunique::text, 'primario=' || i.indisprimary::text,
      'valido=' || i.indisvalid::text, 'pronto=' || i.indisready::text, 'vivo=' || i.indislive::text, 'imediato=' || i.indimmediate::text,
      'nulos_iguais=' || coalesce((to_jsonb(i) ->> 'indnullsnotdistinct')::boolean, false)::text)
  FROM r JOIN pg_index i ON i.indrelid = r.oid JOIN pg_class ic ON ic.oid = i.indexrelid
  UNION ALL
  SELECT 'gatilho:' || r.nome || '.' || g.tgname, concat_ws('|', pg_get_triggerdef(g.oid), 'habilitado=' || g.tgenabled::text)
  FROM r JOIN pg_trigger g ON g.tgrelid = r.oid AND NOT g.tgisinternal
  UNION ALL
  SELECT 'gatilhos_internos:' || r.nome,
    'fora_do_modo_O=' || (SELECT count(*) FROM pg_trigger g WHERE g.tgrelid = r.oid AND g.tgisinternal AND g.tgenabled <> 'O')::text
  FROM r
  UNION ALL
  SELECT 'gatilhos_fk:' || r.nome || '.' || k.conname,
    coalesce((SELECT string_agg(x, ',' ORDER BY x COLLATE "C") FROM (
      SELECT format('%s.%s:%s:%s:%s', tn.nspname, tc.relname, f.proname, g.tgtype, g.tgenabled) AS x
      FROM pg_trigger g JOIN pg_class tc ON tc.oid = g.tgrelid JOIN pg_namespace tn ON tn.oid = tc.relnamespace
        JOIN pg_proc f ON f.oid = g.tgfoid
      WHERE g.tgconstraint = k.oid) s), '')
  FROM r JOIN pg_constraint k ON k.conrelid = r.oid AND k.contype = 'f'
  UNION ALL
  SELECT 'uuid_publico:gen_random_uuid()', coalesce((SELECT string_agg(concat_ws('|',
      'extensao=' || coalesce((SELECT string_agg(e.extname, ',') FROM pg_depend dp JOIN pg_extension e ON e.oid = dp.refobjid
        WHERE dp.classid = 'pg_proc'::regclass AND dp.objid = p.oid AND dp.refclassid = 'pg_extension'::regclass AND dp.deptype = 'e'), ''),
      'linguagem=' || l.lanname, 'simbolo=' || p.prosrc, 'biblioteca=' || coalesce(p.probin, ''),
      'retorno=' || format_type(p.prorettype, NULL), 'volatil=' || p.provolatile::text), ';')
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_language l ON l.oid = p.prolang
    WHERE n.nspname = 'public' AND p.proname = 'gen_random_uuid'), 'ausente')
  UNION ALL
  SELECT 'funcao:' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
    concat_ws('|', 'corpo=' || encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex'), 'linguagem=' || l.lanname,
      'retorno=' || format_type(p.prorettype, NULL), 'tipo=' || p.prokind::text, 'definer=' || p.prosecdef::text, 'volatil=' || p.provolatile::text,
      'estrita=' || p.proisstrict::text, 'leakproof=' || p.proleakproof::text, 'paralelo=' || p.proparallel::text,
      'config=' || coalesce(array_to_string(p.proconfig, ','), ''), 'dono_da_aplicacao=' || (p.proowner = (SELECT relowner FROM dono))::text)
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_language l ON l.oid = p.prolang
  WHERE n.nspname = 'public' AND p.proname = 'mcp_oauth_concessao_revogacao_imutavel'
) inventario
ORDER BY chave COLLATE "C";
