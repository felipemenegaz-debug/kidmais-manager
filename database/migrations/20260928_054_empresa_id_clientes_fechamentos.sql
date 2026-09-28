BEGIN;

-- Kidmais Manager
-- Migration 054 — empresa_id explícito em Clientes e Fechamentos (PR-B1)
--
-- Adiciona clientes.empresa_id e fechamentos.empresa_id (uuid, nulos no legado, FK para
-- empresas), faz o backfill comprovável, torna a empresa imutável e trava a coerência:
--   fechamentos.empresa_id = pacotes.empresa_id (política de legado da 040/053);
--   nova associação cliente↔fechamento e cliente↔revisão exige a mesma empresa comprovada.
-- Não altera a unicidade de CPF (clientes_cpf_canonico_uk continua global; PR-B2).
--
-- Backfill (sem heurística):
--   fechamentos: empresa do pacote gravado. Pacote sem empresa -> fechamento NULL.
--   clientes: por grupo canônico (o cliente e os cadastros mesclados nele). 0 empresas -> NULL;
--     1 empresa -> essa empresa; 2+ empresas -> aborta.
--
-- Sequência (transação única; qualquer erro desfaz tudo, inclusive DISABLE TRIGGER):
--   1. dependências conferidas pelo catálogo, antes de qualquer objeto;
--   2. trava; ambiguidade; estado anterior e resultado esperado em tabelas temporárias;
--   3. colunas e índices (nenhum DML ainda, nenhum evento de gatilho pendente);
--   4. desliga só clientes_atualizado_em_trg e fechamentos_atualizado_em_trg — nenhuma guarda
--      de integridade é desligada;
--   5. UPDATE de fechamentos: enfileira os eventos diferidos das guardas 014/016/019;
--   6. SET CONSTRAINTS ALL IMMEDIATE: essas guardas validam agora cada fechamento tocado, e
--      nenhum evento fica pendente para os ALTER TABLE seguintes (o PostgreSQL recusa
--      ALTER TABLE com evento pendente na tabela);
--   7. UPDATE de clientes; religa os dois gatilhos de timestamp;
--   8. cria funções e gatilhos da 054 e confere histórico, backfill esperado e preservação.
-- Diferente da 046, nenhuma guarda de segurança é desligada: só o carimbo de atualizado_em.
--
-- Rollback: database/rollback/20260928_054_empresa_id_clientes_fechamentos_down.sql.

SET LOCAL lock_timeout = '5s';

-- =============================================================================
-- 1. DEPENDÊNCIAS (antes de qualquer objeto)
-- =============================================================================

DO $$
DECLARE
  divergentes text;
BEGIN
  IF to_regclass('public.clientes') IS NULL
     OR to_regclass('public.fechamentos') IS NULL
     OR to_regclass('public.fechamento_revisoes') IS NULL
     OR to_regclass('public.pacotes') IS NULL
     OR to_regclass('public.empresas') IS NULL THEN
    RAISE EXCEPTION '054: clientes, fechamentos, revisões, pacotes ou empresas ausente.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'pacotes' AND column_name = 'empresa_id'
  ) THEN
    RAISE EXCEPTION '054: pacotes.empresa_id ausente.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name IN ('clientes', 'fechamentos') AND column_name = 'empresa_id'
  ) OR to_regprocedure('public.kidmais_054_falhar_se_incompativel()') IS NOT NULL THEN
    RAISE EXCEPTION '054: empresa_id de clientes/fechamentos já existe.';
  END IF;

  -- kidmais-054-dependencias:inicio
  -- Mesmo bloco no precheck e no postcheck. tgtype: ROW=1, BEFORE=2, INSERT=4, DELETE=8, UPDATE=16;
  -- AFTER não tem bit. restricao = gatilho de restrição DEFERRABLE INITIALLY DEFERRED.
  SELECT string_agg(e.gatilho, ', ' ORDER BY e.gatilho) INTO divergentes
    FROM (VALUES
      ('pacotes_empresa_imutavel_trg', 'pacotes', 'public.kidmais_036_empresa_pai_imutavel()', 19, ARRAY['empresa_id'], false),
      ('tabelas_preco_empresa_imutavel_trg', 'tabelas_preco', 'public.kidmais_036_empresa_pai_imutavel()', 19, ARRAY['empresa_id'], false),
      ('adicionais_empresa_imutavel_trg', 'adicionais', 'public.kidmais_036_empresa_pai_imutavel()', 19, ARRAY['empresa_id'], false),
      ('fechamentos_053_empresa_trg', 'fechamentos', 'public.kidmais_053_fechamento()', 23, ARRAY['pacote_id', 'preco_pacote_id', 'regra_desconto_pacote_id', 'tabela_preco_id'], false),
      ('fechamentos_053_filhos_trg', 'fechamentos', 'public.kidmais_053_fechamento_filhos()', 17, ARRAY['pacote_id', 'tabela_preco_id'], true),
      ('fechamento_adicionais_053_empresa_trg', 'fechamento_adicionais', 'public.kidmais_053_fechamento_adicional()', 23, ARRAY['adicional_id', 'fechamento_id', 'preco_adicional_id'], false),
      ('fechamento_revisoes_053_empresa_trg', 'fechamento_revisoes', 'public.kidmais_053_revisao()', 23, ARRAY['fechamento_id', 'pacote_id', 'preco_pacote_id', 'regra_desconto_pacote_id', 'tabela_preco_id'], false),
      ('fechamento_revisoes_053_filhos_trg', 'fechamento_revisoes', 'public.kidmais_053_revisao_filhos()', 17, ARRAY['pacote_id', 'tabela_preco_id'], true),
      ('fechamento_revisao_adicionais_053_empresa_trg', 'fechamento_revisao_adicionais', 'public.kidmais_053_revisao_adicional()', 23, ARRAY['adicional_id', 'fechamento_revisao_id', 'preco_adicional_id'], false),
      ('fechamento_pacote_snapshots_053_empresa_trg', 'fechamento_pacote_snapshots', 'public.kidmais_053_fotografia()', 7, ARRAY[]::text[], false),
      ('fechamento_pacote_composicao_053_empresa_trg', 'fechamento_pacote_composicao', 'public.kidmais_053_composicao()', 7, ARRAY[]::text[], false),
      ('regras_desconto_pacote_053_utilizada_trg', 'regras_desconto_pacote', 'public.kidmais_053_desconto_utilizado()', 19, ARRAY['pacote_id'], false),
      ('clientes_atualizado_em_trg', 'clientes', 'public.kidmais_set_atualizado_em()', 19, ARRAY[]::text[], false),
      ('fechamentos_atualizado_em_trg', 'fechamentos', 'public.kidmais_set_atualizado_em()', 19, ARRAY[]::text[], false),
      -- Guardas históricas sobre fechamentos que o SET CONSTRAINTS ALL IMMEDIATE do backfill
      -- executa (014: fr_*; 019: festa019_*). A 054 só as exige; nunca as desliga nem recria.
      ('fr_fechamento_proteger_trg', 'fechamentos', 'public.kidmais_proteger_fechamento_em_revisao()', 17, ARRAY[]::text[], true),
      ('fr_confirmacao_agenda_trg', 'fechamentos', 'public.kidmais_validar_agenda_revisao()', 21, ARRAY[]::text[], true),
      ('festa019_fechamento', 'fechamentos', 'public.kidmais019_validar_contrato()', 21, ARRAY[]::text[], true),
      ('festa019_lock_fechamento', 'fechamentos', 'public.kidmais019_lock_ocupacao()', 23, ARRAY[]::text[], false)
    ) AS e(gatilho, tabela, funcao, tipo, colunas, restricao)
   WHERE NOT EXISTS (
     SELECT 1
       FROM pg_catalog.pg_trigger t
       JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE NOT t.tgisinternal AND t.tgname = e.gatilho AND c.relname = e.tabela AND n.nspname = 'public'
        AND t.tgfoid = to_regprocedure(e.funcao) AND t.tgtype = e.tipo AND t.tgenabled = 'O'
        AND t.tgqual IS NULL
        AND (t.tgconstraint <> 0) = e.restricao
        AND t.tgdeferrable = e.restricao
        AND t.tginitdeferred = e.restricao
        AND ARRAY(SELECT a.attname::text FROM unnest(t.tgattr::int2[]) AS k(num)
                    JOIN pg_catalog.pg_attribute a ON a.attrelid = t.tgrelid AND a.attnum = k.num
                   ORDER BY a.attname) = e.colunas
   );
  IF divergentes IS NOT NULL THEN
    RAISE EXCEPTION '054: dependência ausente ou degradada: %.', divergentes;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conname = 'fechamento_pacote_snapshots_anterior_mesmo_fechamento_fk'
       AND conrelid = to_regclass('public.fechamento_pacote_snapshots')
       AND contype = 'f' AND convalidated
  ) OR (SELECT count(*) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname LIKE 'kidmais\_053\_%'
           AND p.proconfig @> ARRAY['search_path=pg_catalog, pg_temp'] AND NOT p.prosecdef) <> 15 THEN
    RAISE EXCEPTION '054: instalação da 053 incompleta (FK da fotografia ou funções).';
  END IF;
  -- kidmais-054-dependencias:fim

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('kidmais-054'));
END $$;

-- =============================================================================
-- 2. TRAVA, AMBIGUIDADE, ESTADO ANTERIOR E RESULTADO ESPERADO
-- =============================================================================

LOCK TABLE public.pacotes, public.clientes, public.fechamentos, public.fechamento_revisoes
  IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  ambiguos text;
BEGIN
  WITH grupo AS (
    SELECT c.id AS cliente_id,
           CASE WHEN c.status = 'MESCLADO' THEN c.cliente_principal_id ELSE c.id END AS canonico_id
      FROM public.clientes c
  )
  SELECT string_agg(t.canonico_id::text, ', ' ORDER BY t.canonico_id) INTO ambiguos
    FROM (
      SELECT g.canonico_id
        FROM grupo g
        JOIN public.fechamentos f ON f.cliente_id = g.cliente_id
        JOIN public.pacotes p ON p.id = f.pacote_id
       WHERE p.empresa_id IS NOT NULL
       GROUP BY g.canonico_id
      HAVING count(DISTINCT p.empresa_id) > 1
    ) t;
  IF ambiguos IS NOT NULL THEN
    RAISE EXCEPTION '054: cliente com fechamentos em empresas distintas (grupo canônico): %. A migration não corrige.', ambiguos
      USING ERRCODE = '23514';
  END IF;
END $$;

CREATE TEMP TABLE kidmais_054_antes ON COMMIT DROP AS
SELECT
  (SELECT count(*) FROM public.clientes) AS clientes,
  (SELECT count(*) FROM public.fechamentos) AS fechamentos,
  (SELECT md5(coalesce(string_agg(to_jsonb(c)::text, ',' ORDER BY c.id), '')) FROM public.clientes c) AS clientes_hash,
  (SELECT md5(coalesce(string_agg(to_jsonb(f)::text, ',' ORDER BY f.id), '')) FROM public.fechamentos f) AS fechamentos_hash;

-- Resultado esperado do backfill, calculado pelos pacotes (caminho independente do UPDATE,
-- que usa fechamentos.empresa_id). Uma linha por cliente, inclusive o NULL esperado.
CREATE TEMP TABLE kidmais_054_esperado ON COMMIT DROP AS
WITH grupo AS (
  SELECT c.id AS cliente_id,
         CASE WHEN c.status = 'MESCLADO' THEN c.cliente_principal_id ELSE c.id END AS canonico_id
    FROM public.clientes c
), derivada AS (
  SELECT g.canonico_id,
         count(DISTINCT p.empresa_id) AS empresas,
         (array_agg(DISTINCT p.empresa_id ORDER BY p.empresa_id))[1] AS primeira
    FROM grupo g
    JOIN public.fechamentos f ON f.cliente_id = g.cliente_id
    JOIN public.pacotes p ON p.id = f.pacote_id
   WHERE p.empresa_id IS NOT NULL
   GROUP BY g.canonico_id
)
SELECT g.cliente_id,
       coalesce(d.empresas, 0) AS empresas_comprovadas,
       CASE WHEN d.empresas = 1 THEN d.primeira END AS empresa_esperada
  FROM grupo g
  LEFT JOIN derivada d ON d.canonico_id = g.canonico_id;

-- =============================================================================
-- 3. COLUNAS
-- =============================================================================

ALTER TABLE public.clientes
  ADD COLUMN empresa_id uuid
  CONSTRAINT clientes_054_empresa_fk REFERENCES public.empresas (id) ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE public.fechamentos
  ADD COLUMN empresa_id uuid
  CONSTRAINT fechamentos_054_empresa_fk REFERENCES public.empresas (id) ON UPDATE RESTRICT ON DELETE RESTRICT;

CREATE INDEX clientes_054_empresa_idx ON public.clientes (empresa_id) WHERE empresa_id IS NOT NULL;
CREATE INDEX fechamentos_054_empresa_idx ON public.fechamentos (empresa_id) WHERE empresa_id IS NOT NULL;

-- =============================================================================
-- 4. BACKFILL
-- =============================================================================

-- Só o carimbo de atualizado_em. Nenhum DML ocorreu ainda: não há evento pendente.
ALTER TABLE public.clientes DISABLE TRIGGER clientes_atualizado_em_trg;
ALTER TABLE public.fechamentos DISABLE TRIGGER fechamentos_atualizado_em_trg;

UPDATE public.fechamentos f
   SET empresa_id = p.empresa_id
  FROM public.pacotes p
 WHERE p.id = f.pacote_id
   AND p.empresa_id IS NOT NULL;

-- As guardas diferidas (014/016/019) do UPDATE acima rodam aqui, não no COMMIT. Daqui em diante
-- nenhum evento fica pendente entre comandos, e os ALTER TABLE abaixo não encontram fila.
SET CONSTRAINTS ALL IMMEDIATE;

WITH grupo AS (
  SELECT c.id AS cliente_id,
         CASE WHEN c.status = 'MESCLADO' THEN c.cliente_principal_id ELSE c.id END AS canonico_id
    FROM public.clientes c
), unica AS (
  -- count(DISTINCT) = 1: o primeiro elemento do array ordenado é a empresa comprovada.
  -- min(uuid) não existe no PostgreSQL padrão.
  SELECT g.canonico_id, (array_agg(DISTINCT f.empresa_id ORDER BY f.empresa_id))[1] AS empresa_id
    FROM grupo g
    JOIN public.fechamentos f ON f.cliente_id = g.cliente_id
   WHERE f.empresa_id IS NOT NULL
   GROUP BY g.canonico_id
  HAVING count(DISTINCT f.empresa_id) = 1
)
UPDATE public.clientes c
   SET empresa_id = u.empresa_id
  FROM grupo g
  JOIN unica u ON u.canonico_id = g.canonico_id
 WHERE g.cliente_id = c.id
   AND c.empresa_id IS NULL;

ALTER TABLE public.clientes ENABLE TRIGGER clientes_atualizado_em_trg;
ALTER TABLE public.fechamentos ENABLE TRIGGER fechamentos_atualizado_em_trg;

-- =============================================================================
-- 5. IMUTABILIDADE
-- =============================================================================

CREATE FUNCTION public.kidmais_054_empresa_imutavel()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.empresa_id IS DISTINCT FROM OLD.empresa_id THEN
    RAISE EXCEPTION '054: a empresa de % não muda.', TG_TABLE_NAME
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER clientes_054_empresa_imutavel_trg
BEFORE UPDATE OF empresa_id ON public.clientes
FOR EACH ROW EXECUTE FUNCTION public.kidmais_054_empresa_imutavel();

CREATE TRIGGER fechamentos_054_empresa_imutavel_trg
BEFORE UPDATE OF empresa_id ON public.fechamentos
FOR EACH ROW EXECUTE FUNCTION public.kidmais_054_empresa_imutavel();

-- =============================================================================
-- 6. COERÊNCIA fechamentos.empresa_id <-> pacotes.empresa_id
-- Política da 040/053: NULL/NULL válido; mesma empresa válida; resto recusado.
-- =============================================================================

CREATE FUNCTION public.kidmais_054_fechamento_empresa_coerente()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  empresa_pacote uuid;
BEGIN
  SELECT empresa_id INTO empresa_pacote FROM public.pacotes WHERE id = NEW.pacote_id;
  IF NEW.empresa_id IS DISTINCT FROM empresa_pacote THEN
    RAISE EXCEPTION '054: fechamentos.empresa_id diverge da empresa do pacote.'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER fechamentos_054_empresa_coerente_trg
BEFORE INSERT OR UPDATE OF empresa_id, pacote_id ON public.fechamentos
FOR EACH ROW EXECUTE FUNCTION public.kidmais_054_fechamento_empresa_coerente();

-- =============================================================================
-- 7. COERÊNCIA cliente <-> fechamento e cliente <-> revisão em NOVA associação
-- As duas empresas preenchidas e iguais; NULL nunca autoriza. Linha histórica só é
-- revalidada se o cliente (ou o fechamento da revisão) mudar. A empresa do cliente e a do
-- fechamento são imutáveis, então não há corrida entre a leitura e o COMMIT.
-- =============================================================================

CREATE FUNCTION public.kidmais_054_fechamento_cliente_coerente()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  empresa_cliente uuid;
BEGIN
  IF NEW.cliente_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.cliente_id IS NOT DISTINCT FROM OLD.cliente_id THEN
    RETURN NEW;
  END IF;
  SELECT empresa_id INTO empresa_cliente FROM public.clientes WHERE id = NEW.cliente_id;
  IF NOT FOUND THEN
    RETURN NEW; -- a FK fechamentos_cliente_fk recusa.
  END IF;
  IF empresa_cliente IS NULL OR NEW.empresa_id IS NULL OR empresa_cliente <> NEW.empresa_id THEN
    RAISE EXCEPTION '054: cliente e fechamento sem a mesma empresa comprovada.'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER fechamentos_054_cliente_coerente_trg
BEFORE INSERT OR UPDATE OF cliente_id ON public.fechamentos
FOR EACH ROW EXECUTE FUNCTION public.kidmais_054_fechamento_cliente_coerente();

CREATE FUNCTION public.kidmais_054_revisao_cliente_coerente()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  empresa_cliente uuid;
  empresa_fechamento uuid;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.cliente_id IS NOT DISTINCT FROM OLD.cliente_id
     AND NEW.fechamento_id IS NOT DISTINCT FROM OLD.fechamento_id THEN
    RETURN NEW;
  END IF;
  SELECT empresa_id INTO empresa_fechamento FROM public.fechamentos WHERE id = NEW.fechamento_id;
  SELECT empresa_id INTO empresa_cliente FROM public.clientes WHERE id = NEW.cliente_id;
  IF empresa_cliente IS NULL OR empresa_fechamento IS NULL OR empresa_cliente <> empresa_fechamento THEN
    RAISE EXCEPTION '054: cliente da revisão sem a mesma empresa comprovada do fechamento.'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER fechamento_revisoes_054_cliente_coerente_trg
BEFORE INSERT OR UPDATE OF cliente_id, fechamento_id ON public.fechamento_revisoes
FOR EACH ROW EXECUTE FUNCTION public.kidmais_054_revisao_cliente_coerente();

-- =============================================================================
-- 8. CRITÉRIO OPERACIONAL (vale sempre; repetido no postcheck)
-- =============================================================================

CREATE FUNCTION public.kidmais_054_falhar_se_incompativel()
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  fechamentos_n bigint;
  ambiguos_n bigint;
  clientes_n bigint;
  vinculos_n bigint;
  revisoes_n bigint;
  mesclados_n bigint;
BEGIN
  -- Todo fechamento com a empresa do pacote gravado.
  SELECT count(*) INTO fechamentos_n
    FROM public.fechamentos f
    JOIN public.pacotes p ON p.id = f.pacote_id
   WHERE f.empresa_id IS DISTINCT FROM p.empresa_id;

  -- Nenhum grupo canônico com fechamentos em mais de uma empresa.
  WITH grupo AS (
    SELECT c.id AS cliente_id,
           CASE WHEN c.status = 'MESCLADO' THEN c.cliente_principal_id ELSE c.id END AS canonico_id
      FROM public.clientes c
  )
  SELECT count(*) INTO ambiguos_n
    FROM (
      SELECT g.canonico_id
        FROM grupo g
        JOIN public.fechamentos f ON f.cliente_id = g.cliente_id
       WHERE f.empresa_id IS NOT NULL
       GROUP BY g.canonico_id
      HAVING count(DISTINCT f.empresa_id) > 1
    ) t;

  -- Todo cliente de grupo com empresa comprovável tem exatamente essa empresa.
  WITH grupo AS (
    SELECT c.id AS cliente_id,
           CASE WHEN c.status = 'MESCLADO' THEN c.cliente_principal_id ELSE c.id END AS canonico_id
      FROM public.clientes c
  ), unica AS (
    SELECT g.canonico_id, (array_agg(DISTINCT f.empresa_id ORDER BY f.empresa_id))[1] AS empresa_id
      FROM grupo g
      JOIN public.fechamentos f ON f.cliente_id = g.cliente_id
     WHERE f.empresa_id IS NOT NULL
     GROUP BY g.canonico_id
    HAVING count(DISTINCT f.empresa_id) = 1
  )
  SELECT count(*) INTO clientes_n
    FROM public.clientes c
    JOIN grupo g ON g.cliente_id = c.id
    JOIN unica u ON u.canonico_id = g.canonico_id
   WHERE c.empresa_id IS DISTINCT FROM u.empresa_id;

  -- Nenhum fechamento ligado a cliente de outra empresa.
  SELECT count(*) INTO vinculos_n
    FROM public.fechamentos f
    JOIN public.clientes c ON c.id = f.cliente_id
   WHERE f.empresa_id IS NOT NULL
     AND c.empresa_id IS NOT NULL
     AND f.empresa_id <> c.empresa_id;

  -- Nenhuma revisão com cliente de outra empresa que a do fechamento.
  SELECT count(*) INTO revisoes_n
    FROM public.fechamento_revisoes r
    JOIN public.fechamentos f ON f.id = r.fechamento_id
    JOIN public.clientes c ON c.id = r.cliente_id
   WHERE f.empresa_id IS NOT NULL
     AND c.empresa_id IS NOT NULL
     AND f.empresa_id <> c.empresa_id;

  -- Cadastro mesclado e principal na mesma empresa quando ambos a têm.
  SELECT count(*) INTO mesclados_n
    FROM public.clientes s
    JOIN public.clientes p ON p.id = s.cliente_principal_id
   WHERE s.status = 'MESCLADO'
     AND s.empresa_id IS NOT NULL
     AND p.empresa_id IS NOT NULL
     AND s.empresa_id <> p.empresa_id;

  IF fechamentos_n + ambiguos_n + clientes_n + vinculos_n + revisoes_n + mesclados_n > 0 THEN
    RAISE EXCEPTION '054: empresa incompatível (fechamentos=%, grupos ambíguos=%, clientes=%, vínculos=%, revisões=%, mesclados=%). A migration não corrige.',
      fechamentos_n, ambiguos_n, clientes_n, vinculos_n, revisoes_n, mesclados_n
      USING ERRCODE = '23514';
  END IF;
END;
$$;

SELECT public.kidmais_054_falhar_se_incompativel();

-- =============================================================================
-- 9. PROVA DO BACKFILL IMEDIATO E PRESERVAÇÃO
-- =============================================================================

DO $$
DECLARE
  antes record;
  divergentes bigint;
BEGIN
  -- Cada cliente tem exatamente a empresa esperada: 0 empresas comprovadas -> NULL;
  -- 1 empresa -> essa empresa (2+ já abortou). Compara também o NULL.
  IF (SELECT count(*) FROM kidmais_054_esperado) <> (SELECT count(*) FROM public.clientes) THEN
    RAISE EXCEPTION '054: resultado esperado não cobre todos os clientes.';
  END IF;
  SELECT count(*) INTO divergentes
    FROM public.clientes c
    LEFT JOIN kidmais_054_esperado e ON e.cliente_id = c.id
   WHERE e.cliente_id IS NULL
      OR c.empresa_id IS DISTINCT FROM e.empresa_esperada
      OR (e.empresas_comprovadas = 0 AND c.empresa_id IS NOT NULL)
      OR (e.empresas_comprovadas = 1 AND c.empresa_id IS NULL)
      OR e.empresas_comprovadas > 1;
  IF divergentes > 0 THEN
    RAISE EXCEPTION '054: backfill de clientes diverge do esperado em % linha(s).', divergentes;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.fechamentos f JOIN public.pacotes p ON p.id = f.pacote_id
     WHERE f.empresa_id IS DISTINCT FROM p.empresa_id
  ) THEN
    RAISE EXCEPTION '054: backfill de fechamentos diverge do pacote.';
  END IF;

  SELECT * INTO antes FROM kidmais_054_antes;
  IF (SELECT count(*) FROM public.clientes) <> antes.clientes
     OR (SELECT count(*) FROM public.fechamentos) <> antes.fechamentos THEN
    RAISE EXCEPTION '054: contagem de clientes ou fechamentos mudou.';
  END IF;
  IF (SELECT md5(coalesce(string_agg((to_jsonb(c) - 'empresa_id')::text, ',' ORDER BY c.id), '')) FROM public.clientes c) <> antes.clientes_hash
     OR (SELECT md5(coalesce(string_agg((to_jsonb(f) - 'empresa_id')::text, ',' ORDER BY f.id), '')) FROM public.fechamentos f) <> antes.fechamentos_hash THEN
    RAISE EXCEPTION '054: o backfill alterou coluna além de empresa_id.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
     WHERE tgname IN ('clientes_atualizado_em_trg', 'fechamentos_atualizado_em_trg')
       AND NOT tgisinternal
       AND tgenabled <> 'O'
  ) THEN
    RAISE EXCEPTION '054: gatilho de atualizado_em não voltou.';
  END IF;
END $$;

COMMIT;
