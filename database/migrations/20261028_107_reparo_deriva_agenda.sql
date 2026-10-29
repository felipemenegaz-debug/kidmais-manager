-- 107: reparo da deriva conhecida da agenda (plano "Retomada 098", rev. 2.1, D-R2a aceita por Felipe em 28/10/2026).
-- O diagnóstico somente leitura do staging (25/10/2026, nota "Saloes fase 1 salao inteiro 20261023") achou, em
-- bloqueios_agenda e configuracao_agenda, objetos da 005 recriados com outros nomes (ix_*/ck_*) e objetos ausentes.
-- Esta migration leva os dois estados aceitos ao MESMO catálogo canônico da 005:
--   * base canônica (cadeia recriada do zero): nada muda (no-op), e o registro fica vazio;
--   * deriva conhecida, objeto a objeto: renomeia 3 índices e 6 CHECKs para o nome da 005 (definição conferida antes),
--     cria os 2 gatilhos atualizado_em e os 3 CHECKs nao_vazio (só se nenhum dado os viola).
-- Qualquer outra forma (definição diferente, os dois nomes juntos, gatilho de atualizado_em com outro nome, dado que
-- viola um CHECK a criar, constraint não validada, índice inválido) RECUSA e nada é alterado.
-- A definição esperada é gerada nesta transação numa tabela temporária com as MESMAS colunas (LIKE), e comparada pelo
-- texto do próprio PostgreSQL (pg_get_constraintdef/pg_get_indexdef/pg_get_triggerdef): equivalência demonstrada
-- pelo servidor, sem normalizar casts à mão (parecer do Astra, P2-2 da rev. 1).
-- Proveniência (P2-R2-1 da rev. 2): public.kidmais107_reparos guarda, na mesma transação, cada ação com o estado
-- anterior. O down desfaz SÓ o que está registrado; sem o registro, recusa.
-- Executar somente após autorização própria do ambiente, precheck, backup operacional (PITR) e integridade.
-- Rollback: database/rollback/20261028_107_reparo_deriva_agenda_down.sql.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;

CREATE TABLE public.kidmais107_reparos (
  ordem smallint PRIMARY KEY,
  acao text NOT NULL CHECK (acao IN ('RENOMEAR_INDICE', 'RENOMEAR_CHECK', 'CRIAR_GATILHO', 'CRIAR_CHECK')),
  tabela text NOT NULL CHECK (tabela IN ('bloqueios_agenda', 'configuracao_agenda')),
  nome_anterior text,
  nome_novo text NOT NULL,
  definicao text NOT NULL,
  registrado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((acao LIKE 'RENOMEAR_%') = (nome_anterior IS NOT NULL))
);
COMMENT ON TABLE public.kidmais107_reparos IS
'107: proveniência do reparo da deriva da agenda. Vazia = base canônica (nada mudou). Lida pelo down da 107.';

DO $$
DECLARE
  o record;
  modelo text;
  atual_canonico text;
  atual_deriva text;
  ordem smallint := 0;
  tmp text;
BEGIN
  IF to_regclass('public.configuracao_agenda') IS NULL OR to_regclass('public.bloqueios_agenda') IS NULL
     OR to_regprocedure('public.kidmais_set_atualizado_em()') IS NULL THEN
    RAISE EXCEPTION '107: precheck falhou (agenda da 005 ausente); nada alterado';
  END IF;
  -- Modelos com as MESMAS colunas e tipos; definições geradas aqui pelo servidor.
  CREATE TEMP TABLE kidmais107_m_configuracao_agenda (LIKE public.configuracao_agenda) ON COMMIT DROP;
  CREATE TEMP TABLE kidmais107_m_bloqueios_agenda (LIKE public.bloqueios_agenda) ON COMMIT DROP;

  FOR o IN SELECT * FROM (VALUES
      (1,  'I', 'bloqueios_agenda',    'bloqueios_agenda_data_ativos_idx',           'ix_bloqueios_agenda_data_ativos',         '(data) WHERE ativo = true'),
      (2,  'I', 'bloqueios_agenda',    'bloqueios_agenda_intervalo_ativos_idx',      'ix_bloqueios_agenda_intervalo_ativos',    '(data, horario_inicio, horario_fim) WHERE ativo = true AND dia_inteiro = false'),
      (3,  'I', 'configuracao_agenda', 'configuracao_agenda_ativos_idx',             'ix_configuracao_agenda_ativos',           '(ordem_exibicao) WHERE ativo = true'),
      (4,  'K', 'bloqueios_agenda',    'bloqueios_agenda_periodo_check',             'ck_bloqueios_agenda_periodo',
           '(dia_inteiro = true AND horario_inicio IS NULL AND horario_fim IS NULL) OR (dia_inteiro = false AND horario_inicio IS NOT NULL AND horario_fim IS NOT NULL AND horario_fim > horario_inicio)'),
      (5,  'K', 'configuracao_agenda', 'configuracao_agenda_intervalo_check',        'ck_configuracao_agenda_intervalo',        'horario_fim_padrao > horario_inicio_padrao'),
      (6,  'K', 'configuracao_agenda', 'configuracao_agenda_tolerancia_check',       'ck_configuracao_agenda_tolerancia',       'tolerancia_inicio_minutos BETWEEN 0 AND 180'),
      (7,  'K', 'configuracao_agenda', 'configuracao_agenda_passo_check',            'ck_configuracao_agenda_passo',            'passo_inicio_minutos BETWEEN 1 AND 180'),
      (8,  'K', 'configuracao_agenda', 'configuracao_agenda_passo_compativel_check', 'ck_configuracao_agenda_passo_compativel', 'tolerancia_inicio_minutos = 0 OR mod(tolerancia_inicio_minutos, passo_inicio_minutos) = 0'),
      (9,  'K', 'configuracao_agenda', 'configuracao_agenda_ordem_check',            'ck_configuracao_agenda_ordem',            'ordem_exibicao > 0'),
      (10, 'N', 'bloqueios_agenda',    'bloqueios_agenda_motivo_nao_vazio',          NULL,                                      'btrim(motivo) <> '''''),
      (11, 'N', 'configuracao_agenda', 'configuracao_agenda_codigo_nao_vazio',       NULL,                                      'btrim(codigo) <> '''''),
      (12, 'N', 'configuracao_agenda', 'configuracao_agenda_nome_nao_vazio',         NULL,                                      'btrim(nome) <> '''''),
      (13, 'T', 'bloqueios_agenda',    'bloqueios_agenda_atualizado_em_trg',         NULL,                                      NULL),
      (14, 'T', 'configuracao_agenda', 'configuracao_agenda_atualizado_em_trg',      NULL,                                      NULL)
    ) AS v(n, tipo, tabela, canonico, deriva, expr) ORDER BY n
  LOOP
    tmp := 'kidmais107_m_' || o.tabela;
    IF o.tipo = 'I' THEN
      EXECUTE format('CREATE INDEX %I ON pg_temp.%I %s', 'kidmais107_mi' || o.n, tmp, o.expr);
      modelo := regexp_replace(pg_get_indexdef(('pg_temp.kidmais107_mi' || o.n)::regclass), '^CREATE INDEX \S+ ON \S+ ', '');
      SELECT regexp_replace(pg_get_indexdef(i.indexrelid), '^CREATE INDEX \S+ ON \S+ ', '') || CASE WHEN i.indisvalid AND i.indisready THEN '' ELSE ' [INVALIDO]' END
        INTO atual_canonico FROM pg_index i WHERE i.indexrelid = to_regclass('public.' || o.canonico) AND i.indrelid = ('public.' || o.tabela)::regclass;
      SELECT regexp_replace(pg_get_indexdef(i.indexrelid), '^CREATE INDEX \S+ ON \S+ ', '') || CASE WHEN i.indisvalid AND i.indisready THEN '' ELSE ' [INVALIDO]' END
        INTO atual_deriva FROM pg_index i WHERE i.indexrelid = to_regclass('public.' || o.deriva) AND i.indrelid = ('public.' || o.tabela)::regclass;
    ELSIF o.tipo IN ('K', 'N') THEN
      EXECUTE format('ALTER TABLE pg_temp.%I ADD CONSTRAINT %I CHECK (%s)', tmp, 'kidmais107_mk' || o.n, o.expr);
      SELECT pg_get_constraintdef(c.oid) INTO modelo FROM pg_constraint c
       WHERE c.conrelid = ('pg_temp.' || tmp)::regclass AND c.conname = 'kidmais107_mk' || o.n;
      SELECT pg_get_constraintdef(c.oid) || CASE WHEN c.contype = 'c' AND c.convalidated AND NOT c.connoinherit THEN '' ELSE ' [FORMA]' END
        INTO atual_canonico FROM pg_constraint c WHERE c.conrelid = ('public.' || o.tabela)::regclass AND c.conname = o.canonico;
      atual_deriva := NULL;
      IF o.deriva IS NOT NULL THEN
        SELECT pg_get_constraintdef(c.oid) || CASE WHEN c.contype = 'c' AND c.convalidated AND NOT c.connoinherit THEN '' ELSE ' [FORMA]' END
          INTO atual_deriva FROM pg_constraint c WHERE c.conrelid = ('public.' || o.tabela)::regclass AND c.conname = o.deriva;
      END IF;
    ELSE
      -- Estrutural (o texto de pg_get_triggerdef depende do search_path): BEFORE UPDATE FOR EACH ROW (tgtype 19), a
      -- função da 005, sem argumentos, sem WHEN, sem lista de colunas, ligado.
      modelo := '19|kidmais_set_atualizado_em()|0|true|0|O';
      SELECT t.tgtype || '|' || t.tgfoid::regprocedure::text || '|' || t.tgnargs || '|' || (t.tgqual IS NULL) || '|' || cardinality(t.tgattr::int2[]) || '|' || t.tgenabled::text
        INTO atual_canonico FROM pg_trigger t WHERE t.tgrelid = ('public.' || o.tabela)::regclass AND t.tgname = o.canonico AND NOT t.tgisinternal;
      atual_deriva := NULL;
      -- Outro gatilho chamando a mesma função na tabela: deriva desconhecida (criar duplicaria o efeito).
      IF EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = ('public.' || o.tabela)::regclass AND NOT t.tgisinternal
                  AND t.tgfoid = 'public.kidmais_set_atualizado_em()'::regprocedure AND t.tgname <> o.canonico) THEN
        RAISE EXCEPTION '107: % tem gatilho de atualizado_em com outro nome; forma desconhecida; nada alterado', o.tabela;
      END IF;
    END IF;

    IF atual_canonico IS NOT NULL AND atual_deriva IS NULL THEN
      IF atual_canonico IS DISTINCT FROM modelo THEN
        RAISE EXCEPTION '107: % com definição diferente da 005 (% <> %); nada alterado', o.canonico, atual_canonico, modelo;
      END IF;
      CONTINUE;  -- já canônico
    END IF;
    IF atual_canonico IS NOT NULL AND atual_deriva IS NOT NULL THEN
      RAISE EXCEPTION '107: % e % existem juntos; forma desconhecida; nada alterado', o.canonico, o.deriva;
    END IF;
    ordem := ordem + 1;
    IF atual_deriva IS NOT NULL THEN
      IF atual_deriva IS DISTINCT FROM modelo THEN
        RAISE EXCEPTION '107: % com definição diferente da 005 (% <> %); nada alterado', o.deriva, atual_deriva, modelo;
      END IF;
      IF o.tipo = 'I' THEN
        EXECUTE format('ALTER INDEX public.%I RENAME TO %I', o.deriva, o.canonico);
      ELSE
        EXECUTE format('ALTER TABLE public.%I RENAME CONSTRAINT %I TO %I', o.tabela, o.deriva, o.canonico);
      END IF;
      INSERT INTO public.kidmais107_reparos (ordem, acao, tabela, nome_anterior, nome_novo, definicao)
      VALUES (ordem, CASE o.tipo WHEN 'I' THEN 'RENOMEAR_INDICE' ELSE 'RENOMEAR_CHECK' END, o.tabela, o.deriva, o.canonico, modelo);
    ELSIF o.tipo = 'N' THEN
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I WHERE NOT (%s))', o.tabela, o.expr) INTO STRICT atual_deriva;
      IF atual_deriva::boolean THEN
        RAISE EXCEPTION '107: % não pode ser criado: há linha que o viola; corrija com autorização antes; nada alterado', o.canonico;
      END IF;
      EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (%s)', o.tabela, o.canonico, o.expr);
      INSERT INTO public.kidmais107_reparos (ordem, acao, tabela, nome_anterior, nome_novo, definicao)
      VALUES (ordem, 'CRIAR_CHECK', o.tabela, NULL, o.canonico, modelo);
    ELSIF o.tipo = 'T' THEN
      EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.kidmais_set_atualizado_em()', o.canonico, o.tabela);
      INSERT INTO public.kidmais107_reparos (ordem, acao, tabela, nome_anterior, nome_novo, definicao)
      VALUES (ordem, 'CRIAR_GATILHO', o.tabela, NULL, o.canonico, modelo);
    ELSE
      RAISE EXCEPTION '107: % ausente sem a forma conhecida (%); nada alterado', o.canonico, o.deriva;
    END IF;
  END LOOP;
END $$;

-- Postcheck: os 14 objetos canônicos presentes, nenhum nome de deriva sobrou.
DO $$
BEGIN
  IF (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname IN (
        'bloqueios_agenda_data_ativos_idx', 'bloqueios_agenda_intervalo_ativos_idx', 'configuracao_agenda_ativos_idx')) <> 3
     OR (SELECT count(*) FROM pg_constraint WHERE conrelid IN ('public.bloqueios_agenda'::regclass, 'public.configuracao_agenda'::regclass) AND conname IN (
        'bloqueios_agenda_periodo_check', 'configuracao_agenda_intervalo_check', 'configuracao_agenda_tolerancia_check',
        'configuracao_agenda_passo_check', 'configuracao_agenda_passo_compativel_check', 'configuracao_agenda_ordem_check',
        'bloqueios_agenda_motivo_nao_vazio', 'configuracao_agenda_codigo_nao_vazio', 'configuracao_agenda_nome_nao_vazio')) <> 9
     OR (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('bloqueios_agenda_atualizado_em_trg', 'configuracao_agenda_atualizado_em_trg')) <> 2
     OR EXISTS (SELECT 1 FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname IN (
        'ix_bloqueios_agenda_data_ativos', 'ix_bloqueios_agenda_intervalo_ativos', 'ix_configuracao_agenda_ativos'))
     OR EXISTS (SELECT 1 FROM pg_constraint WHERE conname LIKE 'ck\_bloqueios\_agenda\_%' OR conname LIKE 'ck\_configuracao\_agenda\_%') THEN
    RAISE EXCEPTION '107: postcheck falhou; nada alterado';
  END IF;
END $$;

COMMIT;
