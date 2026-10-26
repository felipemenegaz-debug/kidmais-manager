-- Retrato semântico da 102 (somente leitura), parecer do Astra de 26/10/2026 (P2-3). FONTE ÚNICA: o mesmo trecho entre
-- os marcadores RETRATO_102 é embutido, byte a byte, no postcheck, na integridade e no rollback da 102 (o teste estático
-- lib/agenda/retrato-102.test.ts confere). Não confere só nome/contagem: compara a DEFINIÇÃO completa de
--   * colunas novas de agenda_saloes e de todas as colunas das três tabelas novas (tipo, NOT NULL, default);
--   * constraints c/f/p/u/x (tabela, tipo, pg_get_constraintdef, validada, adiável) — NOT NULL vai por attnotnull;
--   * índices (pg_get_indexdef, único, primário, válido, pronto, imediato);
--   * gatilhos (pg_get_triggerdef, inclusive WHEN e eventos, e tgenabled);
--   * as nove funções kidmais102_*: corpo (sem CR) e atributos (linguagem, SECURITY DEFINER, volatilidade, STRICT,
--     LEAKPROOF, PARALLEL, proconfig/search_path, retorno);
--   * o conteúdo do catálogo (código, grupo, nome, ordem, idades, pede_detalhe; "ativo" pode mudar só por migration).
-- Normalização: prefixo "public." removido das definições (depende do search_path da sessão); ordenação em "C".
-- O deparse do PostgreSQL pode variar entre versões maiores: o hash esperado foi medido no PostgreSQL 18; antes de
-- aplicar em outro servidor, o aplicador roda este retrato no modo de conferência e para em qualquer diferença.
SELECT
-- RETRATO_102_INICIO
(SELECT encode(sha256(convert_to(r.retrato::text, 'UTF8')), 'hex') FROM (SELECT jsonb_build_object(
  'colunas', (SELECT coalesce(jsonb_agg(jsonb_build_array(c.relname, a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull,
                regexp_replace(coalesce(pg_get_expr(d.adbin, d.adrelid), ''), '\mpublic\.', '', 'g'), a.attidentity, a.attgenerated)
                ORDER BY c.relname COLLATE "C", a.attname COLLATE "C"), '[]'::jsonb)
     FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE n.nspname = 'public' AND a.attnum > 0 AND NOT a.attisdropped
       AND (c.relname IN ('agenda_salao_itens_catalogo', 'agenda_salao_itens', 'agenda_salao_fotos')
            OR (c.relname = 'agenda_saloes' AND a.attname IN ('convidados_minimo', 'convidados_sentados', 'area_m2', 'idade_min', 'idade_max',
                'frase', 'outra_festa_simultanea', 'exclusivos', 'fotos_referencia', 'declaracao_em', 'declaracao_por', 'declaracao_versao',
                'conteudo_versao')))),
  'constraints', (SELECT coalesce(jsonb_agg(jsonb_build_array(k.conname, c.relname, k.contype,
                regexp_replace(pg_get_constraintdef(k.oid), '\mpublic\.', '', 'g'), k.convalidated, k.condeferrable, k.condeferred)
                ORDER BY k.conname COLLATE "C"), '[]'::jsonb)
     FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_class c ON c.oid = k.conrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND k.contype IN ('c', 'f', 'p', 'u', 'x')
       AND (c.relname IN ('agenda_salao_itens_catalogo', 'agenda_salao_itens', 'agenda_salao_fotos')
            OR (c.relname = 'agenda_saloes' AND k.conname LIKE 'agenda\_saloes\_102\_%'))),
  'indices', (SELECT coalesce(jsonb_agg(jsonb_build_array(ic.relname, regexp_replace(pg_get_indexdef(i.indexrelid), '\mpublic\.', '', 'g'),
                i.indisunique, i.indisprimary, i.indisvalid, i.indisready, i.indimmediate) ORDER BY ic.relname COLLATE "C"), '[]'::jsonb)
     FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid JOIN pg_catalog.pg_class tc ON tc.oid = i.indrelid
     JOIN pg_catalog.pg_namespace n ON n.oid = tc.relnamespace
     WHERE n.nspname = 'public' AND tc.relname IN ('agenda_salao_itens_catalogo', 'agenda_salao_itens', 'agenda_salao_fotos')),
  'gatilhos', (SELECT coalesce(jsonb_agg(jsonb_build_array(g.tgname, c.relname, regexp_replace(pg_get_triggerdef(g.oid), '\mpublic\.', '', 'g'),
                g.tgenabled) ORDER BY g.tgname COLLATE "C"), '[]'::jsonb)
     FROM pg_catalog.pg_trigger g JOIN pg_catalog.pg_class c ON c.oid = g.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE NOT g.tgisinternal AND n.nspname = 'public'
       AND (c.relname IN ('agenda_salao_itens_catalogo', 'agenda_salao_itens', 'agenda_salao_fotos')
            OR (c.relname = 'agenda_saloes' AND g.tgname LIKE '%\_102\_%'))),
  'funcoes', (SELECT coalesce(jsonb_agg(jsonb_build_array(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
                encode(sha256(convert_to(replace(p.prosrc, E'\r', ''), 'UTF8')), 'hex'), l.lanname, p.prosecdef, p.provolatile, p.proisstrict,
                p.proleakproof, p.proparallel, coalesce(array_to_string(p.proconfig, ';'), ''), format_type(p.prorettype, NULL))
                ORDER BY p.proname COLLATE "C", pg_get_function_identity_arguments(p.oid) COLLATE "C"), '[]'::jsonb)
     FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace JOIN pg_catalog.pg_language l ON l.oid = p.prolang
     WHERE n.nspname = 'public' AND p.proname LIKE 'kidmais102\_%'),
  'catalogo', (SELECT coalesce(jsonb_agg(jsonb_build_array(x.codigo, x.grupo, x.nome, x.ordem, x.idade_min, x.idade_max, x.pede_detalhe)
                ORDER BY x.codigo COLLATE "C"), '[]'::jsonb)
     FROM public.agenda_salao_itens_catalogo x)
) AS retrato) r)
-- RETRATO_102_FIM
  AS hash_102;
