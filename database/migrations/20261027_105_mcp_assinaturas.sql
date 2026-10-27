-- 105: canal MCP externo por assinatura (ChatGPT/Claude/Gemini do próprio usuário) — persistência OAuth.
-- Plano: docs/MCP_ASSINATURAS_V1.md (27/10/2026; revisão do Astra: pronta para P4; suíte PG aprovada em descartável; NÃO APLICADA).
--   * só metadados de SEGURANÇA (clientes CIMD, pedidos pendentes, concessões, códigos, tokens e auditoria);
--     nenhuma tabela de negócio é alterada;
--   * segredos guardados só como SHA-256 hex (valores de 256 bits gerados pelo servidor);
--   * concessão sempre de UM usuário em UMA empresa; revogada não volta (revogada_em imutável depois de gravada);
--   * auditoria sem token, consulta, documento, nome ou valor (CHECKs de tamanho/forma);
--   * número 105 conferido em 27/10/2026 em todos os clones locais e branches remotas (era 104; staging tomou a 104 na #251);
--     NÃO é reserva.
-- Rollback: database/rollback/20261027_105_mcp_assinaturas_down.sql (recusa se houver concessão ativa; ver docs).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;
DO $$
BEGIN
  IF to_regclass('public.usuarios_administrativos') IS NULL OR to_regclass('public.empresas') IS NULL OR to_regclass('public.memberships') IS NULL THEN
    RAISE EXCEPTION '105: precheck falhou (usuarios_administrativos/empresas/memberships ausentes); nada alterado';
  END IF;
  IF to_regclass('public.mcp_oauth_concessoes') IS NOT NULL THEN
    RAISE EXCEPTION '105: precheck falhou (mcp_oauth_concessoes já existe); nada alterado';
  END IF;
END $$;

CREATE TABLE public.mcp_oauth_clientes (
  client_id text PRIMARY KEY CHECK (client_id ~ '^https://[a-z0-9.-]+/' AND length(client_id) <= 500),
  nome text NOT NULL CHECK (length(nome) BETWEEN 1 AND 120),
  redirect_uris text[] NOT NULL CHECK (cardinality(redirect_uris) BETWEEN 1 AND 20),
  valido_ate timestamptz NOT NULL,
  atualizado_em timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE public.mcp_oauth_pedidos (
  chave_hash text PRIMARY KEY CHECK (chave_hash ~ '^[0-9a-f]{64}$'),
  client_id text NOT NULL REFERENCES public.mcp_oauth_clientes (client_id),
  cliente_nome text NOT NULL CHECK (length(cliente_nome) <= 120),
  redirect_uri text NOT NULL CHECK (redirect_uri ~ '^https://' AND length(redirect_uri) <= 500),
  state text NULL CHECK (state IS NULL OR length(state) <= 500),
  code_challenge text NOT NULL CHECK (code_challenge ~ '^[A-Za-z0-9._~-]{43,128}$'),
  escopos text[] NOT NULL CHECK (cardinality(escopos) BETWEEN 1 AND 3 AND escopos <@ ARRAY['agenda:read','financeiro:read','conhecimento:read']),
  recurso text NOT NULL CHECK (length(recurso) <= 500),
  criado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  expira_em timestamptz NOT NULL,
  consumido_em timestamptz NULL,
  CHECK (expira_em > criado_em AND expira_em <= criado_em + interval '15 minutes')
);
CREATE INDEX mcp_oauth_pedidos_expira_idx ON public.mcp_oauth_pedidos (expira_em);
-- Teto persistente de pedidos pendentes por cliente (borda pública) e expurgo por idade.
CREATE INDEX mcp_oauth_pedidos_cliente_idx ON public.mcp_oauth_pedidos (client_id, expira_em) WHERE consumido_em IS NULL;

CREATE TABLE public.mcp_oauth_concessoes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id uuid NOT NULL REFERENCES public.usuarios_administrativos (id),
  empresa_id uuid NOT NULL REFERENCES public.empresas (id),
  client_id text NOT NULL REFERENCES public.mcp_oauth_clientes (client_id),
  cliente_nome text NOT NULL CHECK (length(cliente_nome) <= 120),
  redirect_uri text NOT NULL CHECK (redirect_uri ~ '^https://' AND length(redirect_uri) <= 500),
  escopos text[] NOT NULL CHECK (cardinality(escopos) BETWEEN 1 AND 3 AND escopos <@ ARRAY['agenda:read','financeiro:read','conhecimento:read']),
  recurso text NOT NULL CHECK (length(recurso) <= 500),
  criada_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  ultimo_uso_em timestamptz NULL,
  ultima_ferramenta_em timestamptz NULL,
  revogada_em timestamptz NULL,
  revogada_por uuid NULL REFERENCES public.usuarios_administrativos (id),
  motivo_revogacao text NULL CHECK (motivo_revogacao IN ('USUARIO', 'REUSO', 'SUBSTITUIDA')),
  CHECK ((revogada_em IS NULL) = (motivo_revogacao IS NULL))
);
-- Uma concessão ativa por usuário+empresa+cliente (nova autorização substitui a anterior na mesma transação).
CREATE UNIQUE INDEX mcp_oauth_concessoes_ativa_uk ON public.mcp_oauth_concessoes (usuario_id, empresa_id, client_id) WHERE revogada_em IS NULL;
CREATE INDEX mcp_oauth_concessoes_usuario_idx ON public.mcp_oauth_concessoes (usuario_id, criada_em DESC);
CREATE INDEX mcp_oauth_concessoes_empresa_idx ON public.mcp_oauth_concessoes (empresa_id) WHERE revogada_em IS NULL;

CREATE FUNCTION public.mcp_oauth_concessao_revogacao_imutavel() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN
  IF OLD.revogada_em IS NOT NULL AND (NEW.revogada_em IS DISTINCT FROM OLD.revogada_em OR NEW.motivo_revogacao IS DISTINCT FROM OLD.motivo_revogacao) THEN
    RAISE EXCEPTION '105: concessão revogada não pode ser reativada' USING ERRCODE = '23514';
  END IF;
  IF NEW.usuario_id <> OLD.usuario_id OR NEW.empresa_id <> OLD.empresa_id OR NEW.client_id <> OLD.client_id
     OR NEW.escopos <> OLD.escopos OR NEW.recurso <> OLD.recurso OR NEW.criada_em <> OLD.criada_em THEN
    RAISE EXCEPTION '105: identidade da concessão é imutável' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $f$;
CREATE TRIGGER mcp_oauth_concessoes_revogacao_imutavel BEFORE UPDATE ON public.mcp_oauth_concessoes
  FOR EACH ROW EXECUTE FUNCTION public.mcp_oauth_concessao_revogacao_imutavel();

CREATE TABLE public.mcp_oauth_codigos (
  codigo_hash text PRIMARY KEY CHECK (codigo_hash ~ '^[0-9a-f]{64}$'),
  concessao_id uuid NOT NULL REFERENCES public.mcp_oauth_concessoes (id),
  redirect_uri text NOT NULL CHECK (length(redirect_uri) <= 500),
  code_challenge text NOT NULL CHECK (code_challenge ~ '^[A-Za-z0-9._~-]{43,128}$'),
  criado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  expira_em timestamptz NOT NULL,
  usado_em timestamptz NULL,
  CHECK (expira_em > criado_em AND expira_em <= criado_em + interval '10 minutes')
);
CREATE INDEX mcp_oauth_codigos_concessao_idx ON public.mcp_oauth_codigos (concessao_id);
CREATE INDEX mcp_oauth_codigos_expira_idx ON public.mcp_oauth_codigos (expira_em);

CREATE TABLE public.mcp_oauth_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  concessao_id uuid NOT NULL REFERENCES public.mcp_oauth_concessoes (id),
  tipo text NOT NULL CHECK (tipo IN ('ACESSO', 'ATUALIZACAO')),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  -- Escopo EFETIVO deste token (refresh pode reduzir; nunca ampliar além da concessão: conferido na gravação).
  escopos text[] NOT NULL CHECK (cardinality(escopos) BETWEEN 1 AND 3 AND escopos <@ ARRAY['agenda:read','financeiro:read','conhecimento:read']),
  criado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  expira_em timestamptz NOT NULL,
  revogado_em timestamptz NULL,
  CHECK (expira_em > criado_em),
  CHECK (tipo <> 'ACESSO' OR expira_em <= criado_em + interval '2 hours'),
  CHECK (tipo <> 'ATUALIZACAO' OR expira_em <= criado_em + interval '31 days')
);
CREATE INDEX mcp_oauth_tokens_concessao_idx ON public.mcp_oauth_tokens (concessao_id) WHERE revogado_em IS NULL;
CREATE INDEX mcp_oauth_tokens_expira_idx ON public.mcp_oauth_tokens (expira_em);

CREATE TABLE public.mcp_auditoria (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ocorrido_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  evento text NOT NULL CHECK (evento IN ('PEDIDO_RECEBIDO','PEDIDO_RECUSADO','AUTORIZACAO_CONCEDIDA','AUTORIZACAO_NEGADA','TOKEN_EMITIDO','TOKEN_RENOVADO','TOKEN_RECUSADO','REUSO_DETECTADO','REVOGACAO','FERRAMENTA')),
  resultado text NOT NULL CHECK (resultado ~ '^[A-Z_]{1,24}$'),
  codigo text NOT NULL CHECK (codigo ~ '^[A-Za-z0-9_:,]{1,80}$'),
  concessao_id uuid NULL,
  usuario_id uuid NULL,
  empresa_id uuid NULL,
  client_id text NULL CHECK (client_id IS NULL OR length(client_id) <= 500),
  capacidade text NULL CHECK (capacidade IS NULL OR capacidade ~ '^[a-z_]{1,64}$'),
  itens integer NULL CHECK (itens IS NULL OR itens BETWEEN 0 AND 10000),
  duracao_ms integer NULL CHECK (duracao_ms IS NULL OR duracao_ms BETWEEN 0 AND 600000)
);
CREATE INDEX mcp_auditoria_ocorrido_idx ON public.mcp_auditoria (ocorrido_em);
CREATE INDEX mcp_auditoria_empresa_idx ON public.mcp_auditoria (empresa_id, ocorrido_em DESC) WHERE empresa_id IS NOT NULL;

COMMENT ON TABLE public.mcp_oauth_concessoes IS '105: delegação OAuth do canal MCP (usuário+empresa+cliente). Revogação persistida e imutável.';
COMMENT ON TABLE public.mcp_auditoria IS '105: auditoria sanitizada do canal MCP (só códigos e ids). Retenção 180 dias por expurgo automático em lotes (RETENCAO_OAUTH; valor RET-1 a confirmar).';
COMMIT;
