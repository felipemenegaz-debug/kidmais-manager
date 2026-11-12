-- Integridade da 102 (somente leitura, repetível): corpos das 9 funções, constraints validadas, gatilhos habilitados,
-- índices válidos e o catálogo com os 28 itens do seed; e o RETRATO SEMÂNTICO (definições completas, mesma fonte do
-- postcheck e do rollback). Não confere dados de salões/fotos/itens (conteúdo legítimo não a afeta).
SELECT (SELECT count(*) FROM (VALUES
    ('kidmais102_catalogo_imutavel()', '9133cdc1c433779467848e3e2f88aacffb15cbd705606d4c4c4db1c366285fa0'),
    ('kidmais102_exclusivos_validos(text[])', 'ac3e6d15e811fbde7db85f43d044aea9cfeba00a03af850cd0f5fadf6bc43241'),
    ('kidmais102_foto_antes()', '018f52e37711de488b0c59ca8a4f31acb2aad441f1d4c1f0aa4c6131fb1b97b6'),
    ('kidmais102_foto_depois()', '13b0015c88f1d201eb6200fa71405892b43684ace8252a2a389a612bdda4cd45'),
    ('kidmais102_invalidar_salao(uuid)', 'e8774a307b870ad74e59094d353d1c23954c80a41f231273e44e843cdf88f5b5'),
    ('kidmais102_item_antes()', '77704e4d9ec4acf6217fbd3665daf66c745844809abe0cb097fcf5c88138332a'),
    ('kidmais102_item_depois()', 'bdaa6a2b5fe32b60d0372ef7ff869075f9d1e4747b06f09c64793bcd1629ce72'),
    ('kidmais102_salao_conteudo()', 'e0ff834d08bd20e810da395b23e132e909e6003b0015fe51b092c3cdb04013b1'),
    ('kidmais102_sem_truncate()', '25051008198158e647e68d261c42dbb9cdbefe6126f5354322d0269f638837b9')) AS e(f, h)
   WHERE (SELECT encode(sha256(convert_to(replace(prosrc, E'\r', ''), 'UTF8')), 'hex') FROM pg_proc WHERE oid = to_regprocedure('public.' || e.f)) = e.h) = 9
  AND (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname LIKE 'kidmais102\_%') = 9
  AND (SELECT count(*) FROM pg_constraint WHERE conname IN ('agenda_saloes_102_minimo_ck', 'agenda_saloes_102_sentados_ck', 'agenda_saloes_102_area_ck', 'agenda_saloes_102_idade_ck', 'agenda_saloes_102_frase_ck', 'agenda_saloes_102_exclusivos_ck', 'agenda_saloes_102_fotos_referencia_ck', 'agenda_saloes_102_declaracao_ck', 'agenda_saloes_102_versao_ck', 'agenda_salao_itens_catalogo_idade_ck', 'agenda_salao_itens_catalogo_codigo_grupo_uk', 'agenda_salao_itens_salao_fk', 'agenda_salao_itens_catalogo_fk', 'agenda_salao_itens_tipo_ck', 'agenda_salao_itens_proprio_ck', 'agenda_salao_fotos_salao_fk', 'agenda_salao_fotos_bytes_ck', 'agenda_salao_fotos_hash_ck', 'agenda_salao_fotos_origem_ck', 'agenda_salao_fotos_remocao_ck') AND convalidated) = 20
  AND (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('agenda_saloes_102_conteudo_trg', 'agenda_salao_itens_catalogo_102_imutavel_trg', 'agenda_salao_itens_catalogo_102_truncate_trg', 'agenda_salao_itens_102_antes_trg', 'agenda_salao_itens_102_depois_trg', 'agenda_salao_itens_102_truncate_trg', 'agenda_salao_fotos_102_antes_trg', 'agenda_salao_fotos_102_depois_trg', 'agenda_salao_fotos_102_truncate_trg') AND tgenabled = 'O') = 9
  AND (SELECT count(*) FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname IN ('agenda_salao_itens_codigo_uk', 'agenda_salao_itens_proprio_uk', 'agenda_salao_itens_empresa_idx', 'agenda_salao_fotos_ordem_uk', 'agenda_salao_fotos_salao_idx', 'agenda_salao_itens_catalogo_pkey', 'agenda_salao_itens_pkey', 'agenda_salao_fotos_pkey') AND i.indisvalid AND i.indisready) = 8
  AND (SELECT count(*) FROM agenda_salao_itens_catalogo) = 28
  -- Parecer do Astra (26/10, P2-3): definições completas (fonte: 20261025_102_retrato.sql).
  AND (
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
  ) = 'bfb4359c9e47709eddbc346ac5523c2274145154be2d141acd46a79704e2799d' AS integra_102;
