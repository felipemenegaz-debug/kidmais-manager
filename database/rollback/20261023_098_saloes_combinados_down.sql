-- Rollback da 098: volta os corpos da 094 de kidmais094_conflito_ocupacao, kidmais019_validar_contrato e
-- kidmais_validar_agenda_revisao e remove salão combinado, guardas e funções da 098, numa única transação.
-- Recusado se a 098 não está aplicada, ou está parcial (o verificador COMPLETO da 098, o mesmo bloco de
-- database/checks/20261023_098_integridade.sql, roda antes de qualquer alteração), ou se existe QUALQUER salão combinado
-- (mesmo inativo ou sem referência: festa, revisão, pacote ou horário poderiam apontar para ele). Antes do COMMIT, o
-- verificador COMPLETO da 094 (o mesmo bloco de database/checks/20261022_094_integridade.sql) confere o resultado:
-- qualquer falha aborta a transação inteira e nada muda. Depois dele, o manifesto da Festa volta ao conjunto 094.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;
DO $$
BEGIN
  IF to_regprocedure('public.kidmais098_hoje()') IS NULL
    OR (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'agenda_saloes'
         AND column_name IN ('combinado', 'membros')) <> 2 THEN
    RAISE EXCEPTION '098 rollback: a 098 não está aplicada (ou está parcial); nada alterado';
  END IF;
  IF EXISTS (SELECT 1 FROM agenda_saloes WHERE combinado OR membros IS NOT NULL) THEN
    RAISE EXCEPTION '098 rollback: existe salão combinado; nada alterado';
  END IF;
END $$;
-- Pré-condição: verificador COMPLETO da 098 (os três blocos de database/checks/20261023_098_integridade.sql, idênticos, inclusive o retrato estrutural 098).
DO $$
DECLARE dono oid := (SELECT relowner FROM pg_class WHERE oid = to_regclass('public.agenda_saloes'));
BEGIN
  -- Tabelas e colunas.
  IF to_regclass('public.agenda_saloes') IS NULL OR to_regclass('public.contratos') IS NULL
    OR NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = to_regclass('public.agenda_saloes') AND a.attname = 'combinado'
                     AND NOT a.attisdropped AND a.attnotnull AND format_type(a.atttypid, a.atttypmod) = 'boolean'
                     AND a.attidentity = '' AND a.attgenerated = ''
                     AND pg_get_expr((SELECT d.adbin FROM pg_attrdef d WHERE d.adrelid = a.attrelid AND d.adnum = a.attnum), a.attrelid) = 'false')
    OR NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = to_regclass('public.agenda_saloes') AND a.attname = 'membros'
                     AND NOT a.attisdropped AND NOT a.attnotnull AND format_type(a.atttypid, a.atttypmod) = 'uuid[]'
                     AND NOT a.atthasdef AND a.attidentity = '' AND a.attgenerated = '')
    OR (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('fechamentos', 'fechamento_revisoes')
         AND column_name = 'salao_id' AND data_type = 'uuid') <> 2 THEN
    RAISE EXCEPTION '098 integridade: tabela ou coluna ausente ou com outro tipo';
  END IF;
  -- Constraints: forma canônica dos membros (validada) e chave primária. As FKs são conferidas pela relação exata no
  -- bloco "FKs exatas", ao final.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('public.agenda_saloes') AND conname = 'agenda_saloes_098_membros_check'
                   AND contype = 'c' AND convalidated
                   AND replace(regexp_replace(pg_get_constraintdef(oid), '\s+', ' ', 'g'), 'public.', '') = 'CHECK ( CASE WHEN combinado THEN kidmais098_membros_canonicos(membros) ELSE (membros IS NULL) END)')
    OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('public.agenda_saloes') AND contype = 'p' AND convalidated) THEN
    RAISE EXCEPTION '098 integridade: constraint ou FK ausente ou não validada';
  END IF;
  -- Corpos: as dez funções novas, as três substituídas e as quatro da 094 que a 098 mantém.
  IF EXISTS (SELECT 1 FROM (VALUES
        ('kidmais098_hoje()', '3a4b2df59eb38d2a5e6f4894fb6dd891f8ef6f793d302b6699184adba825c121'),
        ('kidmais098_membros_canonicos(uuid[])', 'a28f25f25ca6fde6a8687f86ae7a76f557d19e2404a708906c916bd1dbc34fa4'),
        ('kidmais098_conjunto(uuid)', 'a9c7277cc298fb6307f5cfce64a7fe1eea8a0dc2d8a610f5d44bfa9d470d38dc'),
        ('kidmais098_saloes_cruzam(uuid,uuid)', '5fa4a47206e773b5a91028b5c7649e2c6317bc67e3ed548a899448fa6d3a19fe'),
        ('kidmais098_salao_elegivel(uuid)', '9f6e7b59f5ecd89c1a6bf0b67098da041600691979d2e98ae56e8ab3badce4e2'),
        ('kidmais098_validar_elegibilidade(uuid)', 'f54b73da9bf4685524f88971878bb9792d5f6442432f23cf7f3001dc64b99c05'),
        ('kidmais098_salao_guarda()', '9a587402acfe1a1c537b0a7c1a8c3d77e5a1782f2c9e721b32108fde611124c7'),
        ('kidmais098_combinado_validar()', '0d5a2713f41f68b53a6a0bd22b5189cc7e31fcc9b6a7649b59cd9671ee1045ba'),
        ('kidmais098_proibir_truncate()', 'b6fc1e418cc21bdf78952e9ae8ac8aeff89f257c9a9ab92bccba9850d28099df'),
        ('kidmais098_contrato_guarda()', '0ae5abc6372e3edf997bab5b4ab7f213a4d8bb0ff2708c4c4c5db72a5fc74e04'),
        ('kidmais094_conflito_ocupacao(uuid,date,time without time zone,time without time zone,uuid,uuid,uuid,uuid)', 'a3b9bcb198adbe4cd0595c56a5def99aff8463f96f0c192554f42099029ca05a'),
        ('kidmais019_validar_contrato()', '13095fc87c52c3970f9cfad1c5bcef77d3e860904f71b39948de0335b4e76c21'),
        ('kidmais_validar_agenda_revisao()', '8476ec76d2ae8af4f7fbbdba595b0fd82b8060c76be4d2d915a47451f11f9e24'),
        ('kidmais094_salao_fechamento()', 'ea270481051aea570015af300abc4d3b208627c90473a25977e22a1b11be0305'),
        ('kidmais094_salao_revisao()', 'b55b3e839da369ce0e28a52bad7003b391d6af2091075a4bf419c4e7770d4d59'),
        ('kidmais094_ocupacoes(date,date)', '3fa027c88aa5b82c5cbece4ac8a4f51d2b85c7ee18108def1c5974cca1237bbc'),
        ('kidmais019_validar_destino(uuid)', '02bd9366cf05913702b23c72166760dc68aea2e0e61779b5ca60a7b5be7eb6cb')) AS e(f, h)
      WHERE (SELECT encode(sha256(convert_to(replace(prosrc, E'\r', ''), 'UTF8')), 'hex') FROM pg_proc WHERE oid = to_regprocedure('public.' || e.f))
            IS DISTINCT FROM e.h) THEN
    RAISE EXCEPTION '098 integridade: corpo de função ausente ou diferente do da 098';
  END IF;
  -- Privilégios: funções da 098 sem SECURITY DEFINER, com search_path fixo e do mesmo dono das tabelas; nenhuma regra
  -- (RULE) que desvie DML de agenda_saloes ou contratos; TRUNCATE não concedido a PUBLIC.
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname LIKE 'kidmais098\_%'
               AND (prosecdef OR proowner <> dono OR NOT coalesce(proconfig @> ARRAY['search_path=public, pg_catalog'], false)))
    OR (SELECT count(*) FROM pg_proc WHERE proname LIKE 'kidmais098\_%') <> 10
    OR EXISTS (SELECT 1 FROM pg_rewrite WHERE ev_class IN (to_regclass('public.agenda_saloes'), to_regclass('public.contratos')))
    OR EXISTS (SELECT 1 FROM pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
                WHERE c.oid IN (to_regclass('public.agenda_saloes'), to_regclass('public.contratos'))
                  AND a.grantee = 0 AND a.privilege_type = 'TRUNCATE') THEN
    RAISE EXCEPTION '098 integridade: função, dono, regra ou privilégio fora do esperado';
  END IF;
  -- Gatilhos: existentes, habilitados (O), ligados à função certa, com eventos (tgtype), colunas e adiamento esperados.
  IF EXISTS (SELECT 1 FROM (VALUES
        ('agenda_saloes', 'agenda_saloes_098_guarda_trg', 'kidmais098_salao_guarda()', 27, false, NULL::text),
        ('agenda_saloes', 'agenda_saloes_098_combinado_trg', 'kidmais098_combinado_validar()', 7, false, NULL),
        ('agenda_saloes', 'agenda_saloes_098_combinado_diferido', 'kidmais098_combinado_validar()', 5, true, NULL),
        ('agenda_saloes', 'agenda_saloes_098_truncate_trg', 'kidmais098_proibir_truncate()', 34, false, NULL),
        ('contratos', 'contratos_098_guarda_trg', 'kidmais098_contrato_guarda()', 27, false, 'fechamento_id'),
        ('contratos', 'contratos_098_truncate_trg', 'kidmais098_proibir_truncate()', 34, false, NULL),
        ('fechamentos', 'fechamentos_094_salao_trg', 'kidmais094_salao_fechamento()', 23, false, 'salao_id'),
        ('fechamento_revisoes', 'fechamento_revisoes_094_salao_trg', 'kidmais094_salao_revisao()', 23, false, 'salao_id'),
        ('fechamento_revisoes', 'fr_agenda_validar_trg', 'kidmais_validar_agenda_revisao()', 21, true, NULL),
        ('fechamentos', 'fr_confirmacao_agenda_trg', 'kidmais_validar_agenda_revisao()', 21, true, NULL),
        ('contratos', 'festa019_contrato', 'kidmais019_validar_contrato()', 21, true, NULL),
        ('contrato_fluxos', 'festa019_fluxo', 'kidmais019_validar_contrato()', 21, true, NULL),
        ('fechamentos', 'festa019_fechamento', 'kidmais019_validar_contrato()', 21, true, NULL),
        ('festas', 'festa019_festa', 'kidmais019_validar_contrato()', 21, true, NULL)) AS e(t, g, f, tipo, diferido, coluna)
      WHERE NOT EXISTS (SELECT 1 FROM pg_trigger tr WHERE tr.tgrelid = to_regclass('public.' || e.t) AND tr.tgname = e.g AND NOT tr.tgisinternal
                          AND tr.tgenabled = 'O' AND tr.tgfoid = to_regprocedure('public.' || e.f) AND tr.tgtype = e.tipo
                          AND tr.tgdeferrable = e.diferido AND tr.tginitdeferred = e.diferido AND tr.tgqual IS NULL
                          AND array_to_string(tr.tgattr::int2[], ',') = coalesce((SELECT a.attnum::text FROM pg_attribute a
                                WHERE a.attrelid = tr.tgrelid AND a.attname = e.coluna AND NOT a.attisdropped), ''))) THEN
    RAISE EXCEPTION '098 integridade: gatilho ausente, desligado, ligado a outra função ou com outros eventos';
  END IF;
  RAISE NOTICE '098 integridade OK';
END $$;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM (VALUES ('fechamentos', 'salao_id', 'uuid', false, false), ('fechamento_revisoes', 'salao_id', 'uuid', false, false),
                                   ('pacote_saloes', 'salao_id', 'uuid', true, false), ('configuracao_agenda_saloes', 'salao_id', 'uuid', true, false),
                                   ('agenda_saloes', 'id', 'uuid', true, true)) AS e(t, c, tipo, nao_nulo, com_default)
              WHERE NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = to_regclass('public.' || e.t) AND a.attname = e.c
                                  AND NOT a.attisdropped AND a.attnum > 0 AND format_type(a.atttypid, a.atttypmod) = e.tipo AND a.atttypmod = -1
                                  AND a.attnotnull = e.nao_nulo AND a.atthasdef = e.com_default AND a.attidentity = '' AND a.attgenerated = '')) THEN
    RAISE EXCEPTION '098 integridade: coluna salao_id ou de agenda_saloes com outra definição (tipo, nulidade, default, identity ou gerada)';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(ARRAY['fechamentos', 'fechamento_revisoes', 'pacote_saloes', 'configuracao_agenda_saloes']) AS e(t)
              WHERE to_regclass('public.' || e.t) IS NULL
                 OR (SELECT count(*) FROM pg_constraint c WHERE c.contype = 'f' AND c.conrelid = to_regclass('public.' || e.t)
                       AND c.confrelid = to_regclass('public.agenda_saloes')) <> 1
                 OR NOT EXISTS (SELECT 1 FROM pg_constraint c
                                 WHERE c.contype = 'f' AND c.convalidated AND NOT c.condeferrable
                                   AND c.conrelid = to_regclass('public.' || e.t) AND c.confrelid = to_regclass('public.agenda_saloes')
                                   AND c.conkey = ARRAY[(SELECT a.attnum FROM pg_attribute a WHERE a.attrelid = c.conrelid AND a.attname = 'salao_id' AND NOT a.attisdropped)]::int2[]
                                   AND c.confkey = ARRAY[(SELECT a.attnum FROM pg_attribute a WHERE a.attrelid = c.confrelid AND a.attname = 'id' AND NOT a.attisdropped)]::int2[]
                                   AND c.confupdtype = 'r' AND c.confdeltype = 'r' AND c.confmatchtype = 's')) THEN
    RAISE EXCEPTION '098 integridade: FK para agenda_saloes ausente, com outra coluna, outra referência, outra ação ou extra';
  END IF;
  RAISE NOTICE '098 integridade: colunas e FKs exatas OK';
END $$;
DO $$
DECLARE caminho text := current_setting('search_path');
BEGIN
  PERFORM set_config('search_path', 'pg_catalog', true);
  IF encode(sha256(convert_to((
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
  ), 'UTF8')), 'hex') IS DISTINCT FROM '2dfe0b4fb72311b3d5b23df32fe0b8af8dd15dceb469285c0200dcbb9630e64d' THEN
    RAISE EXCEPTION '098 retrato: estrutura diferente do estado 098 esperado; compare com database/checks/20261023_098_retrato.sql';
  END IF;
  PERFORM set_config('search_path', caminho, true);
  RAISE NOTICE '098 retrato 098 OK';
END $$;
-- Trava a tabela dos salões até o COMMIT: nenhum combinado nasce entre a conferência e a remoção.
LOCK TABLE public.agenda_saloes IN SHARE ROW EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM agenda_saloes WHERE combinado OR membros IS NOT NULL) THEN
    RAISE EXCEPTION '098 rollback: existe salão combinado; nada alterado';
  END IF;
END $$;

-- Corpos da 094, idênticos ao arquivo da 094.
CREATE OR REPLACE FUNCTION public.kidmais094_conflito_ocupacao(fid uuid, dia date, ini time, fim time, emp uuid, uni uuid, cfg uuid, salao uuid)
RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path = public, pg_catalog AS $$
DECLARE
  c agenda_escopo_config%ROWTYPE;
  ini_m integer := (extract(epoch FROM ini) / 60)::integer;
  fim_m integer := (extract(epoch FROM fim) / 60)::integer;
  intervalo integer;
  capacidade_horario integer;
BEGIN
  IF emp IS NOT NULL THEN
    SELECT * INTO c FROM agenda_escopo_config a
     WHERE a.empresa_id = emp AND a.estabelecimento_id IS NOT DISTINCT FROM uni;
  END IF;
  IF c.id IS NULL THEN
    RETURN EXISTS (SELECT 1 FROM kidmais094_ocupacoes(dia, dia) o
                    WHERE o.fechamento_id <> fid AND o.horario_inicio < fim AND o.horario_fim > ini
                      AND kidmais062_mesmo_recurso(emp, uni, o.empresa_id, o.estabelecimento_id));
  END IF;
  intervalo := c.intervalo_minimo_minutos;
  IF c.limite_festas_dia IS NOT NULL AND (
       SELECT count(DISTINCT o.fechamento_id) FROM kidmais094_ocupacoes(dia, dia) o
        WHERE o.fechamento_id <> fid AND kidmais062_mesmo_recurso(emp, uni, o.empresa_id, o.estabelecimento_id)
     ) >= c.limite_festas_dia THEN
    RETURN true;
  END IF;
  IF c.capacidade_tipo = 'POR_SALAO' THEN
    RETURN EXISTS (SELECT 1 FROM kidmais094_ocupacoes(dia, dia) o
                    WHERE o.fechamento_id <> fid AND kidmais062_mesmo_recurso(emp, uni, o.empresa_id, o.estabelecimento_id)
                      AND (o.salao_id IS NULL OR salao IS NULL OR o.salao_id = salao)
                      AND (extract(epoch FROM o.horario_inicio) / 60)::integer < fim_m + intervalo
                      AND (extract(epoch FROM o.horario_fim) / 60)::integer > ini_m - intervalo);
  END IF;
  IF EXISTS (SELECT 1 FROM kidmais094_ocupacoes(dia, dia) o
              WHERE o.fechamento_id <> fid AND kidmais062_mesmo_recurso(emp, uni, o.empresa_id, o.estabelecimento_id)
                AND o.configuracao_agenda_id IS DISTINCT FROM cfg AND o.horario_inicio < fim AND o.horario_fim > ini) THEN
    RETURN true;
  END IF;
  SELECT ca.capacidade INTO capacidade_horario FROM configuracao_agenda ca WHERE ca.id = cfg;
  -- Fechamentos distintos: a remarcação em hold ocupa a origem e o destino, mas é UMA festa (parecer do Astra, P2).
  RETURN (SELECT count(DISTINCT o.fechamento_id) FROM kidmais094_ocupacoes(dia, dia) o
           WHERE o.fechamento_id <> fid AND kidmais062_mesmo_recurso(emp, uni, o.empresa_id, o.estabelecimento_id)
             AND o.configuracao_agenda_id = cfg
             AND (extract(epoch FROM o.horario_inicio) / 60)::integer < fim_m + intervalo
             AND (extract(epoch FROM o.horario_fim) / 60)::integer > ini_m - intervalo) >= coalesce(capacidade_horario, 1);
END $$;

CREATE OR REPLACE FUNCTION public.kidmais019_validar_contrato() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
DECLARE cid uuid; vid uuid; contrato_estado text; fid uuid;
BEGIN
 IF TG_TABLE_NAME='contratos' THEN cid:=NEW.id;
 ELSIF TG_TABLE_NAME='fechamentos' THEN SELECT id INTO cid FROM contratos WHERE fechamento_id=NEW.id;
 ELSE cid:=NEW.contrato_id; END IF;
 SELECT c.status,c.fechamento_id,cf.versao_vigente_id INTO contrato_estado,fid,vid FROM contratos c
 LEFT JOIN contrato_fluxos cf ON cf.contrato_id=c.id WHERE c.id=cid;
 IF contrato_estado='CANCELADO' THEN
  IF EXISTS(SELECT 1 FROM fechamento_revisoes WHERE contrato_id=cid AND estado IN ('EM_ELABORACAO','CONGELADA'))
  THEN RAISE EXCEPTION 'Cancelamento exige encerrar a preparação' USING ERRCODE='23514'; END IF;
  RETURN NULL;
 END IF;
 IF contrato_estado='ASSINADO' THEN
  IF NOT kidmais019_formalizacao(cid,vid) OR NOT EXISTS(SELECT 1 FROM festas WHERE contrato_id=cid AND invalidada_em IS NULL)
  THEN RAISE EXCEPTION 'Formalização exige duas assinaturas válidas e Festa ativa' USING ERRCODE='23514'; END IF;
 END IF;
 -- Check the actual occupied base, independently of a preparation's destination; only within the same resource.
 IF kidmais019_ocupa(fid) AND EXISTS(
  SELECT 1 FROM kidmais094_ocupacoes('-infinity'::date,'infinity'::date) a
  WHERE a.fechamento_id=fid
   AND kidmais094_conflito_ocupacao(fid,a.data,a.horario_inicio,a.horario_fim,a.empresa_id,a.estabelecimento_id,a.configuracao_agenda_id,a.salao_id))
 THEN RAISE EXCEPTION 'Conflito entre contratações' USING ERRCODE='23514'; END IF;
 IF kidmais019_ocupa(fid) AND EXISTS(
  SELECT 1 FROM kidmais062_ocupacoes_escopo('-infinity'::date,'infinity'::date) o JOIN bloqueios_agenda b ON b.data=o.data AND b.ativo
   AND kidmais062_bloqueio_aplica(b.empresa_id,b.estabelecimento_id,o.empresa_id,o.estabelecimento_id)
  WHERE o.fechamento_id=fid AND (b.dia_inteiro OR b.horario_inicio IS NULL OR b.horario_fim IS NULL OR (b.horario_inicio<o.horario_fim AND b.horario_fim>o.horario_inicio)))
 THEN RAISE EXCEPTION 'Contratação conflita com bloqueio' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.kidmais_validar_agenda_revisao() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r public.fechamento_revisoes%ROWTYPE; f public.fechamentos%ROWTYPE; target_day date; ini time; fim time; fid uuid;
BEGIN
 IF TG_TABLE_NAME='fechamentos' THEN
  SELECT * INTO f FROM public.fechamentos WHERE id=NEW.id;
  IF NOT public.kidmais019_ocupa(f.id) OR public.kidmais061_historico_passado(f.id) THEN RETURN NULL; END IF;
  target_day:=f.data_evento; ini:=f.horario_inicio; fim:=f.horario_fim; fid:=f.id;
 ELSE
  SELECT * INTO r FROM public.fechamento_revisoes WHERE id=NEW.id;
  SELECT * INTO f FROM public.fechamentos WHERE id=r.fechamento_id;
  IF r.estado='CANCELADA' THEN RETURN NULL; END IF;
  IF r.hold_destino_adquirido_em IS NOT NULL AND NOT public.kidmais019_ocupa(f.id) THEN RAISE EXCEPTION 'Hold exige reserva vigente confirmada' USING ERRCODE='23514'; END IF;
  -- A deferred event may observe the already-applied terminal row.
  IF r.hold_destino_adquirido_em IS NULL AND r.estado<>'APLICADA' THEN RETURN NULL; END IF;
  IF r.estado='APLICADA' AND public.kidmais019_ocupa(f.id) AND r.hold_destino_adquirido_em IS NULL THEN RAISE EXCEPTION 'Remarcação confirmada exige hold validado' USING ERRCODE='23514'; END IF;
  target_day:=r.data_evento; ini:=r.horario_inicio; fim:=r.horario_fim; fid:=r.fechamento_id;
 END IF;
 PERFORM public.kidmais_lock_datas_revisao(ARRAY[target_day]);
 IF public.kidmais094_conflito_ocupacao(fid,target_day,ini,fim,f.empresa_id,f.estabelecimento_id,
   CASE WHEN TG_TABLE_NAME='fechamentos' THEN f.configuracao_agenda_id ELSE r.configuracao_agenda_id END,
   CASE WHEN TG_TABLE_NAME='fechamentos' THEN f.salao_id ELSE COALESCE(r.salao_id,f.salao_id) END)
 OR EXISTS(SELECT 1 FROM public.bloqueios_agenda b WHERE b.ativo AND b.data=target_day AND public.kidmais062_bloqueio_aplica(b.empresa_id,b.estabelecimento_id,f.empresa_id,f.estabelecimento_id)
   AND (b.dia_inteiro OR b.horario_inicio IS NULL OR b.horario_fim IS NULL OR (b.horario_inicio<fim AND b.horario_fim>ini))) THEN RAISE EXCEPTION 'Conflito de agenda da revisão' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;


DROP TRIGGER contratos_098_truncate_trg ON public.contratos;
DROP TRIGGER contratos_098_guarda_trg ON public.contratos;
DROP TRIGGER agenda_saloes_098_truncate_trg ON public.agenda_saloes;
DROP TRIGGER agenda_saloes_098_combinado_diferido ON public.agenda_saloes;
DROP TRIGGER agenda_saloes_098_combinado_trg ON public.agenda_saloes;
DROP TRIGGER agenda_saloes_098_guarda_trg ON public.agenda_saloes;
DROP FUNCTION public.kidmais098_contrato_guarda();
DROP FUNCTION public.kidmais098_proibir_truncate();
DROP FUNCTION public.kidmais098_combinado_validar();
DROP FUNCTION public.kidmais098_salao_guarda();
DROP FUNCTION public.kidmais098_validar_elegibilidade(uuid);
DROP FUNCTION public.kidmais098_salao_elegivel(uuid);
DROP FUNCTION public.kidmais098_saloes_cruzam(uuid, uuid);
DROP FUNCTION public.kidmais098_conjunto(uuid);
ALTER TABLE public.agenda_saloes DROP CONSTRAINT agenda_saloes_098_membros_check;
ALTER TABLE public.agenda_saloes DROP COLUMN membros, DROP COLUMN combinado;
DROP FUNCTION public.kidmais098_membros_canonicos(uuid[]);
DROP FUNCTION public.kidmais098_hoje();

-- Pós-condição: verificador COMPLETO da 094 (bloco idêntico ao de database/checks/20261022_094_integridade.sql),
-- o bloco "Colunas e FKs exatas" da 098 e o retrato estrutural 094 (bloco idêntico ao do precheck da 098).
DO $$
BEGIN
  -- Coluna do salão (uuid) e FK validada para agenda_saloes nas duas tabelas.
  IF EXISTS (SELECT 1 FROM unnest(ARRAY['fechamentos', 'fechamento_revisoes']) t
              WHERE NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('public.' || t) AND attname = 'salao_id'
                                  AND NOT attisdropped AND format_type(atttypid, atttypmod) = 'uuid')
                 OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE contype = 'f' AND convalidated AND conrelid = to_regclass('public.' || t)
                                  AND confrelid = to_regclass('public.agenda_saloes'))) THEN
    RAISE EXCEPTION '094 integridade: salao_id ausente, com outro tipo ou sem FK validada';
  END IF;
  -- Corpos das quatro funções novas e das três substituídas (regra de conflito da 094).
  IF EXISTS (SELECT 1 FROM (VALUES
        ('kidmais094_salao_fechamento()', 'ea270481051aea570015af300abc4d3b208627c90473a25977e22a1b11be0305'),
        ('kidmais094_salao_revisao()', 'b55b3e839da369ce0e28a52bad7003b391d6af2091075a4bf419c4e7770d4d59'),
        ('kidmais094_ocupacoes(date,date)', '3fa027c88aa5b82c5cbece4ac8a4f51d2b85c7ee18108def1c5974cca1237bbc'),
        ('kidmais094_conflito_ocupacao(uuid,date,time without time zone,time without time zone,uuid,uuid,uuid,uuid)', 'b6aac1c0b99ed64f4dca94fe5d886e5d5892b82888325010e02adc850def8cf6'),
        ('kidmais019_validar_destino(uuid)', '02bd9366cf05913702b23c72166760dc68aea2e0e61779b5ca60a7b5be7eb6cb'),
        ('kidmais019_validar_contrato()', '4d462947bc173967fe9ff059a4aa857bd068502c042ae81a97c918e3362bf43e'),
        ('kidmais_validar_agenda_revisao()', '951825ad597495b477963ebb74df0120c1e8f4c59d39f6b7b32f53e5baaea821')) AS e(f, h)
      WHERE (SELECT encode(sha256(convert_to(replace(prosrc, E'\r', ''), 'UTF8')), 'hex') FROM pg_proc WHERE oid = to_regprocedure('public.' || e.f))
            IS DISTINCT FROM e.h) THEN
    RAISE EXCEPTION '094 integridade: corpo de função ausente ou diferente do da 094';
  END IF;
  -- Gatilhos habilitados e ligados à função certa: os dois novos do salão e os da 014/019 que executam a regra nova.
  IF EXISTS (SELECT 1 FROM (VALUES ('fechamentos', 'fechamentos_094_salao_trg', 'kidmais094_salao_fechamento()'),
                                   ('fechamento_revisoes', 'fechamento_revisoes_094_salao_trg', 'kidmais094_salao_revisao()'),
                                   ('fechamento_revisoes', 'fr_agenda_validar_trg', 'kidmais_validar_agenda_revisao()'),
                                   ('fechamentos', 'fr_confirmacao_agenda_trg', 'kidmais_validar_agenda_revisao()'),
                                   ('contratos', 'festa019_contrato', 'kidmais019_validar_contrato()'),
                                   ('contrato_fluxos', 'festa019_fluxo', 'kidmais019_validar_contrato()'),
                                   ('fechamentos', 'festa019_fechamento', 'kidmais019_validar_contrato()'),
                                   ('festas', 'festa019_festa', 'kidmais019_validar_contrato()')) AS e(t, g, f)
              WHERE NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = to_regclass('public.' || e.t) AND tgname = e.g AND NOT tgisinternal
                                  AND tgenabled IN ('O', 'A') AND tgfoid = to_regprocedure('public.' || e.f))) THEN
    RAISE EXCEPTION '094 integridade: gatilho ausente, desligado ou ligado a outra função';
  END IF;
  RAISE NOTICE '094 integridade OK';
END $$;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM (VALUES ('fechamentos', 'salao_id', 'uuid', false, false), ('fechamento_revisoes', 'salao_id', 'uuid', false, false),
                                   ('pacote_saloes', 'salao_id', 'uuid', true, false), ('configuracao_agenda_saloes', 'salao_id', 'uuid', true, false),
                                   ('agenda_saloes', 'id', 'uuid', true, true)) AS e(t, c, tipo, nao_nulo, com_default)
              WHERE NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = to_regclass('public.' || e.t) AND a.attname = e.c
                                  AND NOT a.attisdropped AND a.attnum > 0 AND format_type(a.atttypid, a.atttypmod) = e.tipo AND a.atttypmod = -1
                                  AND a.attnotnull = e.nao_nulo AND a.atthasdef = e.com_default AND a.attidentity = '' AND a.attgenerated = '')) THEN
    RAISE EXCEPTION '098 integridade: coluna salao_id ou de agenda_saloes com outra definição (tipo, nulidade, default, identity ou gerada)';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(ARRAY['fechamentos', 'fechamento_revisoes', 'pacote_saloes', 'configuracao_agenda_saloes']) AS e(t)
              WHERE to_regclass('public.' || e.t) IS NULL
                 OR (SELECT count(*) FROM pg_constraint c WHERE c.contype = 'f' AND c.conrelid = to_regclass('public.' || e.t)
                       AND c.confrelid = to_regclass('public.agenda_saloes')) <> 1
                 OR NOT EXISTS (SELECT 1 FROM pg_constraint c
                                 WHERE c.contype = 'f' AND c.convalidated AND NOT c.condeferrable
                                   AND c.conrelid = to_regclass('public.' || e.t) AND c.confrelid = to_regclass('public.agenda_saloes')
                                   AND c.conkey = ARRAY[(SELECT a.attnum FROM pg_attribute a WHERE a.attrelid = c.conrelid AND a.attname = 'salao_id' AND NOT a.attisdropped)]::int2[]
                                   AND c.confkey = ARRAY[(SELECT a.attnum FROM pg_attribute a WHERE a.attrelid = c.confrelid AND a.attname = 'id' AND NOT a.attisdropped)]::int2[]
                                   AND c.confupdtype = 'r' AND c.confdeltype = 'r' AND c.confmatchtype = 's')) THEN
    RAISE EXCEPTION '098 integridade: FK para agenda_saloes ausente, com outra coluna, outra referência, outra ação ou extra';
  END IF;
  RAISE NOTICE '098 integridade: colunas e FKs exatas OK';
END $$;
-- @@BLOCO-RETRATO-INICIO 094
-- Retrato estrutural canônico (rodada 4 do Astra, P2-1): colunas e defaults, constraints, índices, gatilhos, regras,
-- políticas e atributos das funções do escopo idênticos ao estado 094 esperado. Divergência: rodar
-- database/checks/20261023_098_retrato.sql e comparar com o modelo 094 do inventário.
-- Calculado sempre com search_path = pg_catalog (o texto das definições depende do search_path da sessão); o valor
-- anterior é restaurado em seguida.
DO $$
DECLARE caminho text := current_setting('search_path');
BEGIN
  PERFORM set_config('search_path', 'pg_catalog', true);
  IF encode(sha256(convert_to((
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
  ), 'UTF8')), 'hex') IS DISTINCT FROM 'd87890a6d261bccee5c83eaaa29fdd69e8912a8304abf59deaeeb6c243e7a146' THEN
    RAISE EXCEPTION '098 retrato: estrutura diferente do estado 094 esperado; compare com database/checks/20261023_098_retrato.sql';
  END IF;
  PERFORM set_config('search_path', caminho, true);
  RAISE NOTICE '098 retrato 094 OK';
END $$;
-- @@BLOCO-RETRATO-FIM 094
-- Verificação final: 094 completa (os sete corpos da 094) e nada da 098.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM (VALUES
        ('kidmais094_salao_fechamento()', 'ea270481051aea570015af300abc4d3b208627c90473a25977e22a1b11be0305'),
        ('kidmais094_salao_revisao()', 'b55b3e839da369ce0e28a52bad7003b391d6af2091075a4bf419c4e7770d4d59'),
        ('kidmais094_ocupacoes(date,date)', '3fa027c88aa5b82c5cbece4ac8a4f51d2b85c7ee18108def1c5974cca1237bbc'),
        ('kidmais094_conflito_ocupacao(uuid,date,time without time zone,time without time zone,uuid,uuid,uuid,uuid)', 'b6aac1c0b99ed64f4dca94fe5d886e5d5892b82888325010e02adc850def8cf6'),
        ('kidmais019_validar_destino(uuid)', '02bd9366cf05913702b23c72166760dc68aea2e0e61779b5ca60a7b5be7eb6cb'),
        ('kidmais019_validar_contrato()', '4d462947bc173967fe9ff059a4aa857bd068502c042ae81a97c918e3362bf43e'),
        ('kidmais_validar_agenda_revisao()', '951825ad597495b477963ebb74df0120c1e8f4c59d39f6b7b32f53e5baaea821')) AS e(f, h)
      WHERE (SELECT encode(sha256(convert_to(replace(prosrc, E'\r', ''), 'UTF8')), 'hex') FROM pg_proc WHERE oid = to_regprocedure('public.' || e.f))
            IS DISTINCT FROM e.h)
    OR EXISTS (SELECT 1 FROM pg_proc WHERE proname LIKE 'kidmais098\_%')
    OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgname LIKE '%\_098\_%' AND NOT tgisinternal) THEN
    RAISE EXCEPTION '098 rollback: verificação final falhou (094 incompleta ou resto da 098)';
  END IF;
END $$;

COMMIT;
