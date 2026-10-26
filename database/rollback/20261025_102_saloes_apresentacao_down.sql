-- Rollback da 102 (apresentação do salão). Só com autorização própria. Recusado (nada alterado) se houver QUALQUER
-- conteúdo novo: foto (inclusive removida), item, campo opcional preenchido, exclusivos não vazio, versão > 0 ou
-- declaração. Salões preexistentes com os valores neutros não impedem. Exportar não autoriza: a exportação não leva bytes.
-- As tabelas ficam em ACCESS EXCLUSIVE da conferência até o fim (nenhuma escrita entre a guarda e o DROP); timeout ou
-- deadlock abortam o down inteiro. Nada de CASCADE.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
SET LOCAL search_path = public, pg_catalog;
DO $$
BEGIN
  IF to_regclass('public.agenda_salao_fotos') IS NULL OR to_regclass('public.agenda_salao_itens') IS NULL
    OR to_regclass('public.agenda_salao_itens_catalogo') IS NULL
    OR (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'agenda_saloes'
         AND column_name IN ('convidados_minimo', 'convidados_sentados', 'area_m2', 'idade_min', 'idade_max', 'frase',
                             'outra_festa_simultanea', 'exclusivos', 'fotos_referencia', 'declaracao_em', 'declaracao_por',
                             'declaracao_versao', 'conteudo_versao')) <> 13 THEN
    RAISE EXCEPTION '102 rollback: 102 ausente ou parcial; nada alterado';
  END IF;
END $$;
LOCK TABLE public.agenda_saloes, public.agenda_salao_fotos, public.agenda_salao_itens, public.agenda_salao_itens_catalogo IN ACCESS EXCLUSIVE MODE;
-- Parecer do Astra (26/10, P2-3): schema da 102 com deriva material (retrato semântico) recusa antes de remover objetos.
DO $$
BEGIN
  IF (
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
  ) IS DISTINCT FROM 'bfb4359c9e47709eddbc346ac5523c2274145154be2d141acd46a79704e2799d' THEN
    RAISE EXCEPTION '102 rollback: schema da 102 divergente do esperado (retrato semântico); nada alterado';
  END IF;
END $$;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM agenda_salao_fotos) THEN
    RAISE EXCEPTION '102 rollback: há fotos de salão (inclusive removidas); nada alterado';
  END IF;
  IF EXISTS (SELECT 1 FROM agenda_salao_itens) THEN
    RAISE EXCEPTION '102 rollback: há itens de salão; nada alterado';
  END IF;
  IF EXISTS (SELECT 1 FROM agenda_saloes
              WHERE convidados_minimo IS NOT NULL OR convidados_sentados IS NOT NULL OR area_m2 IS NOT NULL
                 OR idade_min IS NOT NULL OR idade_max IS NOT NULL OR frase IS NOT NULL OR outra_festa_simultanea IS NOT NULL
                 OR cardinality(exclusivos) <> 0 OR fotos_referencia IS NOT NULL OR declaracao_em IS NOT NULL
                 OR declaracao_por IS NOT NULL OR declaracao_versao IS NOT NULL OR conteudo_versao <> 0) THEN
    RAISE EXCEPTION '102 rollback: há salão com apresentação preenchida, versão ou declaração; nada alterado';
  END IF;
END $$;

DROP TRIGGER agenda_salao_fotos_102_truncate_trg ON public.agenda_salao_fotos;
DROP TRIGGER agenda_salao_fotos_102_depois_trg ON public.agenda_salao_fotos;
DROP TRIGGER agenda_salao_fotos_102_antes_trg ON public.agenda_salao_fotos;
DROP TABLE public.agenda_salao_fotos;
DROP TRIGGER agenda_salao_itens_102_truncate_trg ON public.agenda_salao_itens;
DROP TRIGGER agenda_salao_itens_102_depois_trg ON public.agenda_salao_itens;
DROP TRIGGER agenda_salao_itens_102_antes_trg ON public.agenda_salao_itens;
DROP TABLE public.agenda_salao_itens;
DROP TRIGGER agenda_salao_itens_catalogo_102_truncate_trg ON public.agenda_salao_itens_catalogo;
DROP TRIGGER agenda_salao_itens_catalogo_102_imutavel_trg ON public.agenda_salao_itens_catalogo;
DROP TABLE public.agenda_salao_itens_catalogo;
DROP TRIGGER agenda_saloes_102_conteudo_trg ON public.agenda_saloes;
ALTER TABLE public.agenda_saloes
  DROP CONSTRAINT agenda_saloes_102_minimo_ck,
  DROP CONSTRAINT agenda_saloes_102_sentados_ck,
  DROP CONSTRAINT agenda_saloes_102_area_ck,
  DROP CONSTRAINT agenda_saloes_102_idade_ck,
  DROP CONSTRAINT agenda_saloes_102_frase_ck,
  DROP CONSTRAINT agenda_saloes_102_exclusivos_ck,
  DROP CONSTRAINT agenda_saloes_102_fotos_referencia_ck,
  DROP CONSTRAINT agenda_saloes_102_declaracao_ck,
  DROP CONSTRAINT agenda_saloes_102_versao_ck,
  DROP COLUMN convidados_minimo,
  DROP COLUMN convidados_sentados,
  DROP COLUMN area_m2,
  DROP COLUMN idade_min,
  DROP COLUMN idade_max,
  DROP COLUMN frase,
  DROP COLUMN outra_festa_simultanea,
  DROP COLUMN exclusivos,
  DROP COLUMN fotos_referencia,
  DROP COLUMN declaracao_em,
  DROP COLUMN declaracao_por,
  DROP COLUMN declaracao_versao,
  DROP COLUMN conteudo_versao;
DROP FUNCTION public.kidmais102_foto_depois();
DROP FUNCTION public.kidmais102_foto_antes();
DROP FUNCTION public.kidmais102_item_depois();
DROP FUNCTION public.kidmais102_item_antes();
DROP FUNCTION public.kidmais102_catalogo_imutavel();
DROP FUNCTION public.kidmais102_sem_truncate();
DROP FUNCTION public.kidmais102_invalidar_salao(uuid);
DROP FUNCTION public.kidmais102_salao_conteudo();
DROP FUNCTION public.kidmais102_exclusivos_validos(text[]);
COMMIT;
