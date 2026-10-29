-- Integridade da 107 (somente leitura, SÓ CATÁLOGO + registro kidmais107_reparos; plano E4 rev. 2.1, E4-2).
-- GERADO por scripts/gerar-107-integridade.cjs de sqlIntegridade107() (scripts/migration-107-definicoes.cjs); não editar à
-- mão: alterar o módulo e regerar (o teste e o --conferir recusam divergência).
-- Confere os 14 objetos da 107 pela DEFINIÇÃO (deparse esperado no PostgreSQL 18), tabela certa, CHECK validado e não
-- NO INHERIT, índice válido/pronto, gatilho ligado com estrutura exata; nenhum nome de deriva; estrutura do registro; e a
-- coerência de cada ação registrada. Registro vazio = base canônica (legítimo). Rodar com search_path = pg_catalog.
DO $$
DECLARE
  kidmais107_l record;
  kidmais107_falhas text[] := ARRAY[]::text[];
BEGIN
  FOR kidmais107_l IN
    WITH
      def(n, tipo, tabela, canonico, deriva, esperado, expr) AS (VALUES
        (1, 'I', 'bloqueios_agenda', 'bloqueios_agenda_data_ativos_idx', 'ix_bloqueios_agenda_data_ativos', 'USING btree (data) WHERE (ativo = true)', '(data) WHERE ativo = true'),
        (2, 'I', 'bloqueios_agenda', 'bloqueios_agenda_intervalo_ativos_idx', 'ix_bloqueios_agenda_intervalo_ativos', 'USING btree (data, horario_inicio, horario_fim) WHERE ((ativo = true) AND (dia_inteiro = false))', '(data, horario_inicio, horario_fim) WHERE ativo = true AND dia_inteiro = false'),
        (3, 'I', 'configuracao_agenda', 'configuracao_agenda_ativos_idx', 'ix_configuracao_agenda_ativos', 'USING btree (ordem_exibicao) WHERE (ativo = true)', '(ordem_exibicao) WHERE ativo = true'),
        (4, 'K', 'bloqueios_agenda', 'bloqueios_agenda_periodo_check', 'ck_bloqueios_agenda_periodo', 'CHECK ((((dia_inteiro = true) AND (horario_inicio IS NULL) AND (horario_fim IS NULL)) OR ((dia_inteiro = false) AND (horario_inicio IS NOT NULL) AND (horario_fim IS NOT NULL) AND (horario_fim > horario_inicio))))', '(dia_inteiro = true AND horario_inicio IS NULL AND horario_fim IS NULL) OR (dia_inteiro = false AND horario_inicio IS NOT NULL AND horario_fim IS NOT NULL AND horario_fim > horario_inicio)'),
        (5, 'K', 'configuracao_agenda', 'configuracao_agenda_intervalo_check', 'ck_configuracao_agenda_intervalo', 'CHECK ((horario_fim_padrao > horario_inicio_padrao))', 'horario_fim_padrao > horario_inicio_padrao'),
        (6, 'K', 'configuracao_agenda', 'configuracao_agenda_tolerancia_check', 'ck_configuracao_agenda_tolerancia', 'CHECK (((tolerancia_inicio_minutos >= 0) AND (tolerancia_inicio_minutos <= 180)))', 'tolerancia_inicio_minutos BETWEEN 0 AND 180'),
        (7, 'K', 'configuracao_agenda', 'configuracao_agenda_passo_check', 'ck_configuracao_agenda_passo', 'CHECK (((passo_inicio_minutos >= 1) AND (passo_inicio_minutos <= 180)))', 'passo_inicio_minutos BETWEEN 1 AND 180'),
        (8, 'K', 'configuracao_agenda', 'configuracao_agenda_passo_compativel_check', 'ck_configuracao_agenda_passo_compativel', 'CHECK (((tolerancia_inicio_minutos = 0) OR (mod(tolerancia_inicio_minutos, passo_inicio_minutos) = 0)))', 'tolerancia_inicio_minutos = 0 OR mod(tolerancia_inicio_minutos, passo_inicio_minutos) = 0'),
        (9, 'K', 'configuracao_agenda', 'configuracao_agenda_ordem_check', 'ck_configuracao_agenda_ordem', 'CHECK ((ordem_exibicao > 0))', 'ordem_exibicao > 0'),
        (10, 'N', 'bloqueios_agenda', 'bloqueios_agenda_motivo_nao_vazio', NULL::text, 'CHECK ((btrim(motivo) <> ''''::text))', 'btrim(motivo) <> '''''),
        (11, 'N', 'configuracao_agenda', 'configuracao_agenda_codigo_nao_vazio', NULL::text, 'CHECK ((btrim((codigo)::text) <> ''''::text))', 'btrim(codigo) <> '''''),
        (12, 'N', 'configuracao_agenda', 'configuracao_agenda_nome_nao_vazio', NULL::text, 'CHECK ((btrim((nome)::text) <> ''''::text))', 'btrim(nome) <> '''''),
        (13, 'T', 'bloqueios_agenda', 'bloqueios_agenda_atualizado_em_trg', NULL::text, '19|kidmais_set_atualizado_em()|0|true|0|O', NULL::text),
        (14, 'T', 'configuracao_agenda', 'configuracao_agenda_atualizado_em_trg', NULL::text, '19|kidmais_set_atualizado_em()|0|true|0|O', NULL::text)
      ),
      base AS (
        SELECT to_regclass('public.bloqueios_agenda') IS NOT NULL AND to_regclass('public.configuracao_agenda') IS NOT NULL
                 AND to_regprocedure('public.kidmais_set_atualizado_em()') IS NOT NULL AS ok,
               current_setting('server_version_num')::int / 10000 AS pg_maior,
               to_regclass('public.kidmais107_reparos') IS NOT NULL AS ja_aplicada
      ),
      obj AS (
        SELECT d.n, d.tipo, d.tabela, d.canonico, d.deriva, d.esperado,
               CASE d.tipo
                 WHEN 'I' THEN (SELECT regexp_replace(pg_get_indexdef(i.indexrelid), '^CREATE INDEX \S+ ON \S+ ', '')
                                  FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
                                 WHERE i.indexrelid = to_regclass('public.' || d.canonico) AND i.indrelid = to_regclass('public.' || d.tabela)
                                   AND c.relkind = 'i' AND c.relnamespace = 'public'::regnamespace
                                   AND i.indisvalid AND i.indisready AND i.indislive AND NOT i.indisunique)
                 WHEN 'T' THEN (SELECT t.tgtype || '|' || CASE WHEN t.tgfoid = to_regprocedure('public.kidmais_set_atualizado_em()') THEN 'kidmais_set_atualizado_em()' ELSE t.tgfoid::regprocedure::text END || '|' || t.tgnargs || '|' || (t.tgqual IS NULL) || '|' || cardinality(t.tgattr::int2[]) || '|' || t.tgenabled::text
                                  FROM pg_trigger t
                                 WHERE t.tgrelid = to_regclass('public.' || d.tabela) AND t.tgname = d.canonico AND NOT t.tgisinternal
                                   AND t.tgfoid = to_regprocedure('public.kidmais_set_atualizado_em()') AND t.tgconstraint = 0 AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL)
                 ELSE (SELECT pg_get_constraintdef(c.oid)
                         FROM pg_constraint c
                        WHERE c.conrelid = to_regclass('public.' || d.tabela) AND c.conname = d.canonico
                          AND c.contype = 'c' AND c.convalidated AND NOT c.connoinherit)
               END AS atual,
               CASE WHEN d.tipo = 'T' THEN (SELECT count(*) FROM pg_trigger t WHERE t.tgrelid = to_regclass('public.' || d.tabela) AND NOT t.tgisinternal
                                                                           AND t.tgfoid = to_regprocedure('public.kidmais_set_atualizado_em()') AND t.tgname <> d.canonico) = 0
                    ELSE true END AS sem_outro_gatilho,
               CASE WHEN d.deriva IS NULL THEN false
                    WHEN d.tipo = 'I' THEN to_regclass('public.' || d.deriva) IS NOT NULL
                    ELSE EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conname = d.deriva) END AS deriva_presente
          FROM def d
      ),
      reg_estr AS (
        SELECT r.oid IS NOT NULL AS existe,
               COALESCE((SELECT c.relkind = 'r' AND c.relpersistence = 'p' AND NOT c.relispartition AND c.relnamespace = 'public'::regnamespace
                           FROM pg_class c WHERE c.oid = r.oid), false) AS forma,
               (SELECT string_agg(a.attname || ' ' || format_type(a.atttypid, a.atttypmod)
                                  || CASE WHEN a.attnotnull THEN ' NOT NULL' ELSE '' END
                                  || COALESCE(' DEFAULT ' || pg_get_expr(ad.adbin, ad.adrelid), '')
                                  || CASE WHEN a.attidentity <> '' OR a.attgenerated <> '' THEN ' [GERADA]' ELSE '' END,
                                  ', ' ORDER BY a.attnum)
                  FROM pg_attribute a LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
                 WHERE a.attrelid = r.oid AND a.attnum > 0 AND NOT a.attisdropped) AS colunas,
               (SELECT string_agg(c.contype::text || ':' || pg_get_constraintdef(c.oid)
                                  || CASE WHEN c.convalidated AND (c.contype <> 'c' OR NOT c.connoinherit) THEN '' ELSE ' [FORMA]' END,
                                  ' | ' ORDER BY c.contype::text COLLATE "C", pg_get_constraintdef(c.oid) COLLATE "C")
                  FROM pg_constraint c WHERE c.conrelid = r.oid AND c.contype <> 'n') AS restricoes
          FROM (SELECT to_regclass('public.kidmais107_reparos')::oid AS oid) r
      ),
      reg_ok AS (
        SELECT e.existe AND e.forma AND e.colunas IS NOT DISTINCT FROM 'ordem smallint NOT NULL, acao text NOT NULL, tabela text NOT NULL, nome_anterior text, nome_novo text NOT NULL, definicao text NOT NULL, registrado_em timestamp with time zone NOT NULL DEFAULT clock_timestamp()'
               AND e.restricoes IS NOT DISTINCT FROM 'c:CHECK (((acao ~~ ''RENOMEAR_%''::text) = (nome_anterior IS NOT NULL))) | c:CHECK ((acao = ANY (ARRAY[''RENOMEAR_INDICE''::text, ''RENOMEAR_CHECK''::text, ''CRIAR_GATILHO''::text, ''CRIAR_CHECK''::text]))) | c:CHECK ((tabela = ANY (ARRAY[''bloqueios_agenda''::text, ''configuracao_agenda''::text]))) | p:PRIMARY KEY (ordem)' AS ok
          FROM reg_estr e
      ),
      reg AS (
        SELECT x.ordem, x.acao, x.tabela, x.nome_anterior, x.nome_novo, x.definicao
          FROM reg_ok o,
               XMLTABLE('/table/row' PASSING (CASE WHEN o.ok THEN query_to_xml('SELECT ordem, acao, tabela, nome_anterior, nome_novo, definicao FROM public.kidmais107_reparos ORDER BY ordem', false, false, '') END)
                        COLUMNS ordem int PATH 'ordem', acao text PATH 'acao', tabela text PATH 'tabela',
                                nome_anterior text PATH 'nome_anterior', nome_novo text PATH 'nome_novo', definicao text PATH 'definicao') x
      ),
      regd AS (
        SELECT r.*, d.n, d.tipo, d.tabela AS d_tabela, d.deriva AS d_deriva, d.esperado AS d_esperado,
               row_number() OVER (ORDER BY r.ordem) AS pos,
               count(*) OVER (PARTITION BY r.nome_novo) AS repeticoes,
               lag(d.n) OVER (ORDER BY r.ordem) AS n_anterior
          FROM reg r LEFT JOIN def d ON d.canonico = r.nome_novo
      ),
      verif(grupo, sub, ok, motivo) AS (
        SELECT 1, 0, b.pg_maior = 18, 'PostgreSQL maior diferente de 18 (constantes de deparse não valem)' FROM base b
        UNION ALL
        SELECT 2, 0, b.ok, 'agenda da 005 ausente (configuracao_agenda, bloqueios_agenda ou kidmais_set_atualizado_em())' FROM base b
        UNION ALL
        SELECT 3, o.n, COALESCE(o.atual = o.esperado, false),
               format('%s (%s) ausente, em outra tabela, inválido, não validado, desligado ou com definição diferente', o.canonico, o.tabela)
          FROM obj o
        UNION ALL
        SELECT 4, o.n, o.sem_outro_gatilho, format('%s: outro gatilho chama a mesma função', o.tabela) FROM obj o WHERE o.tipo = 'T'
        UNION ALL
        SELECT 5, o.n, NOT o.deriva_presente, format('nome de deriva %s ainda existe', o.deriva) FROM obj o WHERE o.deriva IS NOT NULL
        UNION ALL
        SELECT 6, 0, NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conname LIKE 'ck\_bloqueios\_agenda\_%' OR c.conname LIKE 'ck\_configuracao\_agenda\_%'),
               'constraint ck_bloqueios_agenda_*/ck_configuracao_agenda_* ainda existe'
        UNION ALL
        SELECT 7, 0, e.existe, 'registro kidmais107_reparos ausente (107 não aplicada)' FROM reg_estr e
        UNION ALL
        SELECT 8, 0, NOT e.existe OR (e.forma AND e.colunas IS NOT DISTINCT FROM 'ordem smallint NOT NULL, acao text NOT NULL, tabela text NOT NULL, nome_anterior text, nome_novo text NOT NULL, definicao text NOT NULL, registrado_em timestamp with time zone NOT NULL DEFAULT clock_timestamp()'), 'registro kidmais107_reparos: tabela ou colunas diferentes da 107'
          FROM reg_estr e
        UNION ALL
        SELECT 9, 0, NOT e.existe OR e.restricoes IS NOT DISTINCT FROM 'c:CHECK (((acao ~~ ''RENOMEAR_%''::text) = (nome_anterior IS NOT NULL))) | c:CHECK ((acao = ANY (ARRAY[''RENOMEAR_INDICE''::text, ''RENOMEAR_CHECK''::text, ''CRIAR_GATILHO''::text, ''CRIAR_CHECK''::text]))) | c:CHECK ((tabela = ANY (ARRAY[''bloqueios_agenda''::text, ''configuracao_agenda''::text]))) | p:PRIMARY KEY (ordem)', 'registro kidmais107_reparos: PK ou CHECKs diferentes da 107'
          FROM reg_estr e
        UNION ALL
        SELECT 10, r.ordem, r.n IS NOT NULL AND r.repeticoes = 1,
               format('registro ordem %s: alvo %s desconhecido ou repetido', r.ordem, r.nome_novo) FROM regd r
        UNION ALL
        SELECT 11, r.ordem, COALESCE(r.ordem = r.pos AND (r.n_anterior IS NULL OR r.n_anterior < r.n), false),
               format('registro ordem %s: fora da sequência 1..k na ordem dos objetos', r.ordem) FROM regd r
        UNION ALL
        SELECT 12, r.ordem,
               COALESCE(r.acao = CASE r.tipo WHEN 'I' THEN 'RENOMEAR_INDICE' WHEN 'K' THEN 'RENOMEAR_CHECK'
                                             WHEN 'N' THEN 'CRIAR_CHECK' WHEN 'T' THEN 'CRIAR_GATILHO' END
                        AND r.tabela = r.d_tabela
                        AND r.nome_anterior IS NOT DISTINCT FROM CASE WHEN r.tipo IN ('I', 'K') THEN r.d_deriva END
                        AND r.definicao = r.d_esperado, false),
               format('registro ordem %s (%s): ação, tabela, nome anterior ou definição diferentes do que a 107 grava', r.ordem, r.nome_novo) FROM regd r
        UNION ALL
        SELECT 13, r.ordem,
               r.nome_anterior IS NULL OR CASE WHEN r.acao = 'RENOMEAR_INDICE' THEN to_regclass('public.' || r.nome_anterior) IS NULL
                                               ELSE NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conname = r.nome_anterior) END,
               format('registro ordem %s: nome anterior %s ainda existe', r.ordem, r.nome_anterior) FROM regd r
      )
    SELECT ok, motivo FROM verif ORDER BY grupo, sub
  LOOP
    IF kidmais107_l.ok IS NOT TRUE THEN
      kidmais107_falhas := kidmais107_falhas || kidmais107_l.motivo;
    END IF;
  END LOOP;
  IF cardinality(kidmais107_falhas) > 0 THEN
    RAISE EXCEPTION '107 integridade: %', array_to_string(kidmais107_falhas, '; ');
  END IF;
END $$;
