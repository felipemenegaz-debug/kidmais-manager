-- 111 — Pesquisa de satisfação PS-3: link de avaliação do Google por empresa/unidade e auditoria só de acréscimo
--       (plano "Plano pesquisa de satisfacao 20261030", PS-3 rev. 2 + rev. 2.1 + precisões P3, LIBERADO pelo Astra;
--       D-PS3-1..4 decididas por Felipe em 31/10/2026).
--
-- NÃO APLICADA em banco persistente. PS-3 é LOCAL: só o cluster descartável autorizado; staging e produção exigem
-- autorização explícita de Felipe (docs/OPERACAO_AGENTES.md). Exige a 110 (tarefas com UNIQUE (empresa_id, id)) e
-- PostgreSQL 15+ (UNIQUE NULLS NOT DISTINCT).
--
--   * satisfacao_links_avaliacao: um link por (empresa, unidade); unidade NULL = link da empresa (só para envio sem
--     unidade, D-PS3-1). A gramática fechada do Google (D-PS3-2) é conferida pela aplicação na escrita e na saída
--     (lib/satisfacao/links.ts); o CHECK daqui só barra o grosseiro (https, sem espaço, até 500).
--   * satisfacao_auditoria: eventos LINK_INCLUIDO/LINK_TROCADO/LINK_REMOVIDO/TAREFA_CONCLUIDA, gravados na mesma
--     transação da mudança; nulidade por ação, coerência da conclusão com a tarefa, UPDATE/DELETE/TRUNCATE recusados.
-- O código da PS-3 detecta a instalação pelo catálogo (lib/satisfacao/instalacao.ts, o mesmo manifesto do postcheck):
-- sem a 111 (ou com ela parcial) a conclusão de tarefa e os links devolvem 503 antes de tocar em qualquer linha.
-- Down: database/rollback/20261031_111_satisfacao_links_auditoria_down.sql (captura antes; ver o cabeçalho dele).
-- Precheck/postcheck: database/checks/20261031_111_{precheck,postcheck}.sql.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;

DO $$ BEGIN
  IF current_setting('server_version_num')::int < 150000 THEN RAISE EXCEPTION '111 exige PostgreSQL 15+ (NULLS NOT DISTINCT).'; END IF;
  IF to_regclass('public.satisfacao_tarefas') IS NULL OR to_regprocedure('public.kidmais110_tarefa_guarda()') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'satisfacao_tarefas_escopo_uk' AND conrelid = 'public.satisfacao_tarefas'::regclass AND contype = 'u') THEN
    RAISE EXCEPTION '111 exige a 110.';
  END IF;
  IF to_regclass('public.satisfacao_links_avaliacao') IS NOT NULL OR to_regclass('public.satisfacao_auditoria') IS NOT NULL
     OR to_regprocedure('public.kidmais111_link_guarda()') IS NOT NULL OR to_regprocedure('public.kidmais111_auditoria_somente_insercao()') IS NOT NULL
     OR to_regprocedure('public.kidmais111_auditoria_coerencia()') IS NOT NULL THEN
    RAISE EXCEPTION '111 já aplicada (total ou parcialmente).';
  END IF;
END $$;

-- =============================================================================
-- 1. Link de avaliação do Google por empresa/unidade
-- =============================================================================
CREATE TABLE satisfacao_links_avaliacao (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresas (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  estabelecimento_id uuid,
  url text NOT NULL,
  criado_por uuid NOT NULL REFERENCES usuarios_administrativos (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  atualizado_por uuid NOT NULL REFERENCES usuarios_administrativos (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  criado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  atualizado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- MATCH SIMPLE: empresa preenchida e unidade NULL é o link da empresa (a FK de empresa_id cobre a empresa).
  CONSTRAINT satisfacao_links_unidade_fk FOREIGN KEY (empresa_id, estabelecimento_id) REFERENCES estabelecimentos (empresa_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT satisfacao_links_uk UNIQUE NULLS NOT DISTINCT (empresa_id, estabelecimento_id),
  CONSTRAINT satisfacao_links_url CHECK (char_length(url) <= 500 AND url ~ '^https://[!-~]+$')
);

CREATE FUNCTION kidmais111_link_guarda() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.empresa_id IS DISTINCT FROM OLD.empresa_id OR NEW.estabelecimento_id IS DISTINCT FROM OLD.estabelecimento_id
     OR NEW.criado_por IS DISTINCT FROM OLD.criado_por OR NEW.criado_em IS DISTINCT FROM OLD.criado_em THEN
    RAISE EXCEPTION '111: empresa, unidade e criação do link são imutáveis.' USING ERRCODE = '23514';
  END IF;
  NEW.atualizado_em := clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER satisfacao_links_guarda BEFORE UPDATE ON satisfacao_links_avaliacao FOR EACH ROW EXECUTE FUNCTION kidmais111_link_guarda();

-- =============================================================================
-- 2. Auditoria só de acréscimo
-- =============================================================================
CREATE TABLE satisfacao_auditoria (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresas (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  estabelecimento_id uuid,
  ator_usuario_id uuid NOT NULL REFERENCES usuarios_administrativos (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  acao text NOT NULL,
  tarefa_id uuid,
  url_anterior text,
  url_nova text,
  -- Sem default: o serviço passa o instante decisório (o mesmo de concluida_em na conclusão).
  criado_em timestamptz NOT NULL,
  CONSTRAINT satisfacao_auditoria_unidade_fk FOREIGN KEY (empresa_id, estabelecimento_id) REFERENCES estabelecimentos (empresa_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT satisfacao_auditoria_tarefa_fk FOREIGN KEY (empresa_id, tarefa_id) REFERENCES satisfacao_tarefas (empresa_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT satisfacao_auditoria_acao CHECK (acao IN ('LINK_INCLUIDO', 'LINK_TROCADO', 'LINK_REMOVIDO', 'TAREFA_CONCLUIDA')),
  CONSTRAINT satisfacao_auditoria_urls CHECK ((url_anterior IS NULL OR char_length(url_anterior) <= 500) AND (url_nova IS NULL OR char_length(url_nova) <= 500)),
  CONSTRAINT satisfacao_auditoria_nulidade CHECK (CASE acao
    WHEN 'LINK_INCLUIDO' THEN tarefa_id IS NULL AND url_anterior IS NULL AND url_nova IS NOT NULL
    WHEN 'LINK_TROCADO' THEN tarefa_id IS NULL AND url_anterior IS NOT NULL AND url_nova IS NOT NULL AND url_anterior <> url_nova
    WHEN 'LINK_REMOVIDO' THEN tarefa_id IS NULL AND url_anterior IS NOT NULL AND url_nova IS NULL
    WHEN 'TAREFA_CONCLUIDA' THEN tarefa_id IS NOT NULL AND url_anterior IS NULL AND url_nova IS NULL
  END)
);
CREATE INDEX satisfacao_auditoria_empresa_idx ON satisfacao_auditoria (empresa_id, criado_em);

CREATE FUNCTION kidmais111_auditoria_somente_insercao() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION '111: auditoria da pesquisa é só de acréscimo (% recusado).', TG_OP USING ERRCODE = '23514';
END $$;
CREATE TRIGGER satisfacao_auditoria_imutavel BEFORE UPDATE OR DELETE ON satisfacao_auditoria FOR EACH ROW EXECUTE FUNCTION kidmais111_auditoria_somente_insercao();
CREATE TRIGGER satisfacao_auditoria_truncate BEFORE TRUNCATE ON satisfacao_auditoria FOR EACH STATEMENT EXECUTE FUNCTION kidmais111_auditoria_somente_insercao();

-- Conclusão auditada só de tarefa CONCLUIDA, da mesma unidade e pelo mesmo ator (a empresa vem da FK composta).
CREATE FUNCTION kidmais111_auditoria_coerencia() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_catalog, pg_temp AS $$
DECLARE t record;
BEGIN
  IF NEW.acao = 'TAREFA_CONCLUIDA' THEN
    SELECT estabelecimento_id, estado, concluida_por INTO t FROM satisfacao_tarefas WHERE id = NEW.tarefa_id AND empresa_id = NEW.empresa_id;
    IF NOT FOUND THEN RAISE EXCEPTION '111: tarefa da auditoria não existe nesta empresa.' USING ERRCODE = '23514'; END IF;
    IF t.estabelecimento_id IS DISTINCT FROM NEW.estabelecimento_id THEN RAISE EXCEPTION '111: unidade da auditoria difere da tarefa.' USING ERRCODE = '23514'; END IF;
    IF t.estado <> 'CONCLUIDA' THEN RAISE EXCEPTION '111: auditoria de conclusão exige a tarefa CONCLUIDA.' USING ERRCODE = '23514'; END IF;
    IF t.concluida_por IS DISTINCT FROM NEW.ator_usuario_id THEN RAISE EXCEPTION '111: ator da auditoria difere de quem concluiu.' USING ERRCODE = '23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER satisfacao_auditoria_coerencia BEFORE INSERT ON satisfacao_auditoria FOR EACH ROW EXECUTE FUNCTION kidmais111_auditoria_coerencia();

COMMENT ON TABLE satisfacao_links_avaliacao IS
  'Link de avaliação do Google por empresa (unidade NULL) ou unidade. Formato fechado conferido pela aplicação na escrita e na saída; destino de link curto não é resolvido.';
COMMENT ON TABLE satisfacao_auditoria IS
  'Auditoria da pesquisa (PS-3): só INSERT; UPDATE, DELETE e TRUNCATE recusados. Sem token nem dado do cliente; a observação da conclusão fica só na tarefa.';

COMMIT;
