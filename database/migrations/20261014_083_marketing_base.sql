-- 083 — Marketing (Entrega A): capacidades por membership, opções de origem, campanhas, site público por unidade
--       (rascunho, versões publicadas, imagens), domínios personalizados (provedor SIMULADO), contatos captados,
--       atribuições rastreáveis e eventos de clique.
--
-- NÃO APLICADA em banco persistente. Preparada no goal "Marketing local" (14/10/2026), que é SOMENTE LOCAL: aplicar só
-- em banco descartável local com autorização própria; staging e produção exigem autorização explícita de Felipe
-- (docs/OPERACAO_AGENTES.md). Exige 031 (empresas), 043 (estabelecimentos, memberships), 054 (empresa_id em clientes e
-- fechamentos) e 062 (estabelecimento_id em fechamentos). Independe da 060–082.
--
-- Regras de modelagem (docs/MARKETING_LOCAL_20261014.md):
--   * tudo é por empresa; unidade (estabelecimento) é opcional e sempre da mesma empresa (FK composta, como na 062);
--   * atribuição é append-only: correção desativa a vigente e insere outra com `substitui_id` e motivo; nada é apagado;
--     a primeira origem do cliente é a primeira linha CLIENTE dele; cada negociação (fechamento) tem a sua;
--   * contrato herda a atribuição da negociação pelo vínculo existente (contratos.fechamento_id), sem coluna nova;
--   * clique é evento próprio (marketing_eventos): não é contato nem conversa;
--   * o site público lê SOMENTE a versão publicada (marketing_site_versoes, imutável); o rascunho nunca é servido;
--   * domínio: host exclusivo na instalação inteira enquanto não REMOVIDO; neste goal só o provedor SIMULADO existe
--     (CHECK), e a coluna `simulado` impede apresentar domínio simulado como ativo real.
-- Rollback operacional: desligar MARKETING_SITES_PUBLICOS / MARKETING_DOMINIOS_PERSONALIZADOS e voltar o código; o
-- schema é aditivo e fica. O down só existe para banco descartável e recusa enquanto houver contato ou atribuição.
-- Postcheck: database/checks/20261014_083_postcheck.sql. Rollback: database/rollback/20261014_083_marketing_base_down.sql.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;

DO $$ BEGIN
  IF to_regclass('public.empresas') IS NULL OR to_regclass('public.estabelecimentos') IS NULL OR to_regclass('public.memberships') IS NULL
     OR to_regclass('public.clientes') IS NULL OR to_regclass('public.fechamentos') IS NULL OR to_regclass('public.usuarios_administrativos') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.clientes'::regclass AND attname = 'empresa_id' AND NOT attisdropped)
     OR NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.fechamentos'::regclass AND attname = 'estabelecimento_id' AND NOT attisdropped) THEN
    RAISE EXCEPTION '083 exige a 031, a 043, a 054 e a 062.';
  END IF;
  IF to_regclass('public.marketing_campanhas') IS NOT NULL OR to_regclass('public.marketing_sites') IS NOT NULL
     OR to_regclass('public.marketing_membership_capacidades') IS NOT NULL OR to_regclass('public.marketing_atribuicoes') IS NOT NULL
     OR to_regclass('public.marketing_contatos') IS NOT NULL OR to_regclass('public.marketing_dominios') IS NOT NULL THEN
    RAISE EXCEPTION '083 já aplicada (total ou parcialmente).';
  END IF;
END $$;

-- =============================================================================
-- 1. Capacidades de Marketing por membership (mesmo desenho da 056). Gestão tem todas sem concessão.
-- =============================================================================
CREATE TABLE marketing_membership_capacidades (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  capacidade text NOT NULL,
  concedido_por uuid NOT NULL REFERENCES usuarios_administrativos (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  concedido_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  motivo text NOT NULL,
  revogado_por uuid REFERENCES usuarios_administrativos (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  revogado_em timestamptz,
  motivo_revogacao text,
  CONSTRAINT marketing_cap_membership_fk FOREIGN KEY (empresa_id, membership_id)
    REFERENCES memberships (empresa_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT marketing_cap_capacidade CHECK (capacidade IN ('MARKETING_VISUALIZAR', 'MARKETING_CAMPANHAS_EDITAR', 'MARKETING_SITE_EDITAR',
    'MARKETING_SITE_PUBLICAR', 'MARKETING_DOMINIO_CONFIGURAR', 'MARKETING_AUTOMACOES_GERIR')),
  CONSTRAINT marketing_cap_motivo CHECK (length(btrim(motivo)) >= 3),
  CONSTRAINT marketing_cap_revogacao CHECK (
    (revogado_por IS NULL AND revogado_em IS NULL AND motivo_revogacao IS NULL)
    OR (revogado_por IS NOT NULL AND revogado_em IS NOT NULL AND length(btrim(motivo_revogacao)) >= 3))
);
CREATE UNIQUE INDEX marketing_cap_ativa_uk ON marketing_membership_capacidades (membership_id, capacidade) WHERE revogado_em IS NULL;
CREATE INDEX marketing_cap_empresa_idx ON marketing_membership_capacidades (empresa_id, membership_id);

CREATE FUNCTION kidmais083_capacidade_imutavel() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION '083: capacidade de Marketing não é apagada; revogue.'; END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.empresa_id IS DISTINCT FROM OLD.empresa_id OR NEW.membership_id IS DISTINCT FROM OLD.membership_id
     OR NEW.capacidade IS DISTINCT FROM OLD.capacidade OR NEW.concedido_por IS DISTINCT FROM OLD.concedido_por
     OR NEW.concedido_em IS DISTINCT FROM OLD.concedido_em OR NEW.motivo IS DISTINCT FROM OLD.motivo OR OLD.revogado_em IS NOT NULL THEN
    RAISE EXCEPTION '083: concessão de Marketing só pode ser revogada, uma vez.';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER marketing_cap_imutavel BEFORE UPDATE OR DELETE ON marketing_membership_capacidades
  FOR EACH ROW EXECUTE FUNCTION kidmais083_capacidade_imutavel();

-- =============================================================================
-- 2. Opções de origem configuráveis. As padrão vivem no código (lib/marketing/origens.ts); a linha só muda rótulo,
--    ordem ou desativa uma padrão, ou cria uma personalizada. Origem manual é recurso básico do CRM.
-- =============================================================================
CREATE TABLE marketing_origens_opcoes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresas (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  codigo text NOT NULL,
  rotulo text NOT NULL,
  ativa boolean NOT NULL DEFAULT true,
  ordem integer NOT NULL DEFAULT 100,
  personalizada boolean NOT NULL,
  criado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  atualizado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT marketing_origens_codigo CHECK (codigo ~ '^[A-Z][A-Z0-9_]{1,39}$' AND codigo NOT IN ('DESCONHECIDA')),
  CONSTRAINT marketing_origens_personalizada_codigo CHECK (NOT personalizada OR codigo LIKE 'P\_%'),
  CONSTRAINT marketing_origens_rotulo CHECK (char_length(btrim(rotulo)) BETWEEN 2 AND 60),
  CONSTRAINT marketing_origens_ordem CHECK (ordem BETWEEN 0 AND 10000),
  CONSTRAINT marketing_origens_uk UNIQUE (empresa_id, codigo)
);

-- =============================================================================
-- 3. Site público por unidade: rascunho editável + versões publicadas imutáveis + imagens próprias.
-- =============================================================================
CREATE TABLE marketing_sites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresas (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  estabelecimento_id uuid,
  slug text NOT NULL,
  rascunho jsonb NOT NULL,
  rascunho_versao integer NOT NULL DEFAULT 1,
  estado text NOT NULL DEFAULT 'RASCUNHO',
  versao_publicada_id uuid,
  publicado_em timestamptz,
  despublicado_em timestamptz,
  criado_por uuid NOT NULL REFERENCES usuarios_administrativos (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  atualizado_por uuid NOT NULL REFERENCES usuarios_administrativos (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  criado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  atualizado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT marketing_sites_unidade_fk FOREIGN KEY (empresa_id, estabelecimento_id)
    REFERENCES estabelecimentos (empresa_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT marketing_sites_slug CHECK (slug ~ '^[a-z][a-z0-9-]{1,62}[a-z0-9]$'),
  CONSTRAINT marketing_sites_slug_uk UNIQUE (slug),
  CONSTRAINT marketing_sites_escopo_uk UNIQUE (empresa_id, id),
  CONSTRAINT marketing_sites_rascunho_objeto CHECK (jsonb_typeof(rascunho) = 'object' AND octet_length(rascunho::text) <= 200000),
  CONSTRAINT marketing_sites_rascunho_versao CHECK (rascunho_versao >= 1),
  CONSTRAINT marketing_sites_estado CHECK (estado IN ('RASCUNHO', 'PUBLICADO', 'DESPUBLICADO')),
  CONSTRAINT marketing_sites_publicado_tem_versao CHECK (estado <> 'PUBLICADO' OR (versao_publicada_id IS NOT NULL AND publicado_em IS NOT NULL)),
  CONSTRAINT marketing_sites_despublicado_data CHECK (estado <> 'DESPUBLICADO' OR despublicado_em IS NOT NULL)
);
-- Um site por unidade (ou um para a empresa sem unidade).
CREATE UNIQUE INDEX marketing_sites_unidade_uk ON marketing_sites (empresa_id, COALESCE(estabelecimento_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE TABLE marketing_site_versoes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL,
  site_id uuid NOT NULL,
  numero integer NOT NULL,
  conteudo jsonb NOT NULL,
  publicado_por uuid NOT NULL REFERENCES usuarios_administrativos (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  publicado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT marketing_versoes_site_fk FOREIGN KEY (empresa_id, site_id) REFERENCES marketing_sites (empresa_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT marketing_versoes_numero CHECK (numero >= 1),
  CONSTRAINT marketing_versoes_numero_uk UNIQUE (site_id, numero),
  CONSTRAINT marketing_versoes_escopo_uk UNIQUE (site_id, id),
  CONSTRAINT marketing_versoes_conteudo CHECK (jsonb_typeof(conteudo) = 'object' AND octet_length(conteudo::text) <= 200000)
);
ALTER TABLE marketing_sites ADD CONSTRAINT marketing_sites_versao_fk FOREIGN KEY (id, versao_publicada_id)
  REFERENCES marketing_site_versoes (site_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT;

CREATE FUNCTION kidmais083_somente_insercao() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION '083: % é somente inserção (registro histórico).', TG_TABLE_NAME;
END $$;
CREATE TRIGGER marketing_versoes_imutavel BEFORE UPDATE OR DELETE ON marketing_site_versoes
  FOR EACH ROW EXECUTE FUNCTION kidmais083_somente_insercao();

CREATE TABLE marketing_site_imagens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL,
  site_id uuid NOT NULL,
  conteudo bytea NOT NULL,
  mime text NOT NULL,
  bytes integer NOT NULL,
  largura integer NOT NULL,
  altura integer NOT NULL,
  sha256 char(64) NOT NULL,
  descricao text,
  criado_por uuid NOT NULL REFERENCES usuarios_administrativos (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  criado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  removida_em timestamptz,
  CONSTRAINT marketing_imagens_site_fk FOREIGN KEY (empresa_id, site_id) REFERENCES marketing_sites (empresa_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT marketing_imagens_mime CHECK (mime = 'image/webp'),
  CONSTRAINT marketing_imagens_bytes CHECK (bytes BETWEEN 1 AND 2000000 AND bytes = octet_length(conteudo)),
  CONSTRAINT marketing_imagens_dimensoes CHECK (largura BETWEEN 1 AND 4000 AND altura BETWEEN 1 AND 4000),
  CONSTRAINT marketing_imagens_hash CHECK (sha256 = encode(sha256(conteudo), 'hex')),
  CONSTRAINT marketing_imagens_descricao CHECK (descricao IS NULL OR char_length(descricao) <= 140)
);
CREATE INDEX marketing_imagens_site_idx ON marketing_site_imagens (site_id, criado_em DESC) WHERE removida_em IS NULL;

CREATE FUNCTION kidmais083_imagem_controle() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION '083: imagem do site não é apagada; marque como removida.'; END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.empresa_id IS DISTINCT FROM OLD.empresa_id OR NEW.site_id IS DISTINCT FROM OLD.site_id
     OR NEW.conteudo IS DISTINCT FROM OLD.conteudo OR NEW.sha256 IS DISTINCT FROM OLD.sha256 OR NEW.criado_em IS DISTINCT FROM OLD.criado_em
     OR OLD.removida_em IS NOT NULL OR NEW.removida_em IS NULL THEN
    RAISE EXCEPTION '083: imagem do site só pode ser marcada como removida, uma vez.';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER marketing_imagens_controle BEFORE UPDATE OR DELETE ON marketing_site_imagens
  FOR EACH ROW EXECUTE FUNCTION kidmais083_imagem_controle();

-- =============================================================================
-- 4. Domínios personalizados. Host exclusivo na instalação inteira (não REMOVIDO). Só provedor SIMULADO neste goal.
-- =============================================================================
CREATE TABLE marketing_dominios (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL,
  site_id uuid NOT NULL,
  host text NOT NULL,
  principal boolean NOT NULL,
  status text NOT NULL DEFAULT 'PENDENTE_DNS',
  provedor text NOT NULL DEFAULT 'SIMULADO',
  simulado boolean NOT NULL DEFAULT true,
  token_verificacao text NOT NULL,
  ultima_verificacao jsonb NOT NULL DEFAULT '{}'::jsonb,
  verificado_em timestamptz,
  ativado_em timestamptz,
  removido_em timestamptz,
  criado_por uuid NOT NULL REFERENCES usuarios_administrativos (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  criado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  atualizado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT marketing_dominios_site_fk FOREIGN KEY (empresa_id, site_id) REFERENCES marketing_sites (empresa_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT marketing_dominios_host CHECK (char_length(host) BETWEEN 4 AND 253 AND host = lower(host)
    AND host ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$'),
  CONSTRAINT marketing_dominios_status CHECK (status IN ('PENDENTE_DNS', 'VERIFICADO', 'ATIVO', 'FALHOU', 'REMOVIDO')),
  CONSTRAINT marketing_dominios_provedor CHECK (provedor IN ('SIMULADO')),
  CONSTRAINT marketing_dominios_simulado CHECK (simulado = (provedor = 'SIMULADO')),
  CONSTRAINT marketing_dominios_token CHECK (token_verificacao ~ '^[a-f0-9]{32}$'),
  CONSTRAINT marketing_dominios_verificacao_objeto CHECK (jsonb_typeof(ultima_verificacao) = 'object'),
  CONSTRAINT marketing_dominios_verificado CHECK (status NOT IN ('VERIFICADO', 'ATIVO') OR verificado_em IS NOT NULL),
  CONSTRAINT marketing_dominios_ativo CHECK (status <> 'ATIVO' OR ativado_em IS NOT NULL),
  CONSTRAINT marketing_dominios_removido CHECK ((status = 'REMOVIDO') = (removido_em IS NOT NULL))
);
CREATE UNIQUE INDEX marketing_dominios_host_uk ON marketing_dominios (host) WHERE status <> 'REMOVIDO';
CREATE UNIQUE INDEX marketing_dominios_principal_uk ON marketing_dominios (site_id) WHERE principal AND status <> 'REMOVIDO';
CREATE INDEX marketing_dominios_site_idx ON marketing_dominios (empresa_id, site_id);

CREATE FUNCTION kidmais083_dominio_controle() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION '083: domínio não é apagado; remova (status REMOVIDO).'; END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.empresa_id IS DISTINCT FROM OLD.empresa_id OR NEW.site_id IS DISTINCT FROM OLD.site_id
     OR NEW.host IS DISTINCT FROM OLD.host OR NEW.provedor IS DISTINCT FROM OLD.provedor OR NEW.token_verificacao IS DISTINCT FROM OLD.token_verificacao THEN
    RAISE EXCEPTION '083: host, empresa, site, provedor e token do domínio são imutáveis.';
  END IF;
  IF OLD.status = 'REMOVIDO' THEN RAISE EXCEPTION '083: domínio removido não volta; cadastre de novo.'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER marketing_dominios_controle BEFORE UPDATE OR DELETE ON marketing_dominios
  FOR EACH ROW EXECUTE FUNCTION kidmais083_dominio_controle();

-- DNS do provedor simulado: o "mundo externo" de mentira que o adaptador consulta (sem empresa: o DNS real também não tem).
CREATE TABLE marketing_dns_simulado (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  host text NOT NULL,
  tipo text NOT NULL,
  nome text NOT NULL,
  valor text NOT NULL,
  criado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT marketing_dns_tipo CHECK (tipo IN ('TXT', 'CNAME', 'A')),
  CONSTRAINT marketing_dns_tamanhos CHECK (char_length(host) <= 253 AND char_length(nome) <= 253 AND char_length(valor) <= 255),
  CONSTRAINT marketing_dns_uk UNIQUE (host, tipo, nome)
);

-- =============================================================================
-- 5. Campanhas.
-- =============================================================================
CREATE TABLE marketing_campanhas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresas (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  estabelecimento_id uuid,
  site_id uuid,
  codigo text NOT NULL,
  nome text NOT NULL,
  canal text NOT NULL,
  origem_codigo text NOT NULL,
  objetivo text,
  inicio date NOT NULL,
  fim date,
  orcamento_centavos bigint,
  utm_source text NOT NULL,
  utm_medium text NOT NULL,
  status text NOT NULL DEFAULT 'ATIVA',
  arquivada_em timestamptz,
  versao integer NOT NULL DEFAULT 1,
  criada_por uuid NOT NULL REFERENCES usuarios_administrativos (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  atualizada_por uuid NOT NULL REFERENCES usuarios_administrativos (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  criada_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  atualizada_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT marketing_campanhas_unidade_fk FOREIGN KEY (empresa_id, estabelecimento_id)
    REFERENCES estabelecimentos (empresa_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT marketing_campanhas_site_fk FOREIGN KEY (empresa_id, site_id) REFERENCES marketing_sites (empresa_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT marketing_campanhas_escopo_uk UNIQUE (empresa_id, id),
  CONSTRAINT marketing_campanhas_codigo CHECK (codigo ~ '^[a-z0-9][a-z0-9-]{2,46}[a-z0-9]$'),
  CONSTRAINT marketing_campanhas_codigo_uk UNIQUE (empresa_id, codigo),
  CONSTRAINT marketing_campanhas_nome CHECK (char_length(btrim(nome)) BETWEEN 2 AND 120),
  CONSTRAINT marketing_campanhas_canal CHECK (canal IN ('GOOGLE', 'INSTAGRAM', 'FACEBOOK', 'WHATSAPP', 'EMAIL', 'INDICACAO', 'OFFLINE', 'OUTRO')),
  CONSTRAINT marketing_campanhas_origem CHECK (origem_codigo ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  CONSTRAINT marketing_campanhas_objetivo CHECK (objetivo IS NULL OR char_length(objetivo) <= 500),
  CONSTRAINT marketing_campanhas_periodo CHECK (fim IS NULL OR fim >= inicio),
  CONSTRAINT marketing_campanhas_orcamento CHECK (orcamento_centavos IS NULL OR orcamento_centavos BETWEEN 0 AND 99999999999),
  CONSTRAINT marketing_campanhas_utm CHECK (utm_source ~ '^[a-z0-9][a-z0-9._-]{0,59}$' AND utm_medium ~ '^[a-z0-9][a-z0-9._-]{0,59}$'),
  CONSTRAINT marketing_campanhas_status CHECK (status IN ('ATIVA', 'PAUSADA', 'ARQUIVADA')),
  CONSTRAINT marketing_campanhas_arquivada CHECK ((status = 'ARQUIVADA') = (arquivada_em IS NOT NULL)),
  CONSTRAINT marketing_campanhas_versao CHECK (versao >= 1)
);
CREATE INDEX marketing_campanhas_lista_idx ON marketing_campanhas (empresa_id, status, inicio DESC);

CREATE FUNCTION kidmais083_campanha_controle() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION '083: campanha não é apagada; arquive.'; END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.empresa_id IS DISTINCT FROM OLD.empresa_id OR NEW.codigo IS DISTINCT FROM OLD.codigo THEN
    RAISE EXCEPTION '083: empresa e código (identificador dos links) da campanha são imutáveis.';
  END IF;
  IF OLD.status = 'ARQUIVADA' THEN RAISE EXCEPTION '083: campanha arquivada não é alterada.'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER marketing_campanhas_controle BEFORE UPDATE OR DELETE ON marketing_campanhas
  FOR EACH ROW EXECUTE FUNCTION kidmais083_campanha_controle();

-- =============================================================================
-- 6. Contatos captados (pedido de orçamento do site ou registro manual). Não é negociação: fechamento exige data,
--    pacote e preço; o vínculo com a negociação é feito depois, explicitamente.
-- =============================================================================
CREATE TABLE marketing_contatos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresas (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  estabelecimento_id uuid,
  site_id uuid,
  cliente_id uuid REFERENCES clientes (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  fechamento_id uuid REFERENCES fechamentos (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  canal_atendimento text NOT NULL,
  nome text NOT NULL,
  telefone varchar(15),
  email text,
  data_desejada date,
  convidados integer,
  mensagem text,
  chave_idempotencia text NOT NULL,
  vinculo_cliente text NOT NULL,
  status text NOT NULL DEFAULT 'NOVO',
  recebido_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  atualizado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  atualizado_por uuid REFERENCES usuarios_administrativos (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT marketing_contatos_unidade_fk FOREIGN KEY (empresa_id, estabelecimento_id)
    REFERENCES estabelecimentos (empresa_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT marketing_contatos_site_fk FOREIGN KEY (empresa_id, site_id) REFERENCES marketing_sites (empresa_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT marketing_contatos_escopo_uk UNIQUE (empresa_id, id),
  CONSTRAINT marketing_contatos_canal CHECK (canal_atendimento IN ('FORMULARIO_SITE', 'WHATSAPP', 'TELEFONE', 'PRESENCIAL', 'EMAIL', 'OUTRO')),
  CONSTRAINT marketing_contatos_nome CHECK (char_length(btrim(nome)) BETWEEN 2 AND 120),
  CONSTRAINT marketing_contatos_telefone CHECK (telefone IS NULL OR telefone ~ '^[0-9]{10,15}$'),
  CONSTRAINT marketing_contatos_email CHECK (email IS NULL OR (char_length(email) <= 254 AND email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')),
  CONSTRAINT marketing_contatos_meio CHECK (telefone IS NOT NULL OR email IS NOT NULL),
  CONSTRAINT marketing_contatos_convidados CHECK (convidados IS NULL OR convidados BETWEEN 1 AND 5000),
  CONSTRAINT marketing_contatos_mensagem CHECK (mensagem IS NULL OR char_length(mensagem) <= 1000),
  CONSTRAINT marketing_contatos_chave CHECK (chave_idempotencia ~ '^[A-Za-z0-9_-]{16,64}$'),
  CONSTRAINT marketing_contatos_chave_uk UNIQUE (empresa_id, chave_idempotencia),
  CONSTRAINT marketing_contatos_vinculo CHECK (vinculo_cliente IN ('NOVO', 'EXISTENTE_CONTATO', 'MANUAL', 'SEM_CLIENTE')),
  CONSTRAINT marketing_contatos_vinculo_cliente CHECK ((vinculo_cliente = 'SEM_CLIENTE') = (cliente_id IS NULL)),
  CONSTRAINT marketing_contatos_status CHECK (status IN ('NOVO', 'EM_ATENDIMENTO', 'CONVERTIDO', 'DESCARTADO')),
  CONSTRAINT marketing_contatos_convertido CHECK (status <> 'CONVERTIDO' OR fechamento_id IS NOT NULL)
);
CREATE INDEX marketing_contatos_lista_idx ON marketing_contatos (empresa_id, recebido_em DESC);
CREATE INDEX marketing_contatos_cliente_idx ON marketing_contatos (cliente_id) WHERE cliente_id IS NOT NULL;
CREATE UNIQUE INDEX marketing_contatos_fechamento_uk ON marketing_contatos (fechamento_id) WHERE fechamento_id IS NOT NULL;

-- Integridade de tenant: cliente e negociação do contato são da MESMA empresa; a negociação é do cliente do contato.
CREATE FUNCTION kidmais083_contato_tenant() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_catalog, pg_temp AS $$
DECLARE c_empresa uuid; f_empresa uuid; f_cliente uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION '083: contato captado não é apagado.'; END IF;
  IF TG_OP = 'UPDATE' AND (NEW.id IS DISTINCT FROM OLD.id OR NEW.empresa_id IS DISTINCT FROM OLD.empresa_id
     OR NEW.chave_idempotencia IS DISTINCT FROM OLD.chave_idempotencia OR NEW.recebido_em IS DISTINCT FROM OLD.recebido_em
     OR NEW.canal_atendimento IS DISTINCT FROM OLD.canal_atendimento OR NEW.site_id IS DISTINCT FROM OLD.site_id) THEN
    RAISE EXCEPTION '083: empresa, chave, canal, site e data de recebimento do contato são imutáveis.';
  END IF;
  IF NEW.cliente_id IS NOT NULL THEN
    SELECT empresa_id INTO c_empresa FROM clientes WHERE id = NEW.cliente_id;
    IF c_empresa IS DISTINCT FROM NEW.empresa_id THEN RAISE EXCEPTION '083: cliente do contato é de outra empresa.'; END IF;
  END IF;
  IF NEW.fechamento_id IS NOT NULL THEN
    SELECT empresa_id, cliente_id INTO f_empresa, f_cliente FROM fechamentos WHERE id = NEW.fechamento_id;
    IF f_empresa IS DISTINCT FROM NEW.empresa_id THEN RAISE EXCEPTION '083: negociação do contato é de outra empresa.'; END IF;
    IF NEW.cliente_id IS NULL OR f_cliente IS DISTINCT FROM NEW.cliente_id THEN
      RAISE EXCEPTION '083: a negociação vinculada precisa ser do cliente do contato.';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER marketing_contatos_tenant BEFORE INSERT OR UPDATE OR DELETE ON marketing_contatos
  FOR EACH ROW EXECUTE FUNCTION kidmais083_contato_tenant();

-- =============================================================================
-- 7. Atribuições (append-only com vigência). DESCONHECIDA = sem evidência; nunca inventada.
-- =============================================================================
CREATE TABLE marketing_atribuicoes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresas (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  alvo_tipo text NOT NULL,
  alvo_id uuid NOT NULL,
  origem_codigo text NOT NULL,
  canal_atendimento text,
  campanha_id uuid,
  metodo text NOT NULL,
  detalhe text,
  utm jsonb NOT NULL DEFAULT '{}'::jsonb,
  contato_id uuid,
  vigente boolean NOT NULL DEFAULT true,
  substitui_id uuid REFERENCES marketing_atribuicoes (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  motivo text,
  registrado_por uuid REFERENCES usuarios_administrativos (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  registrado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  substituida_em timestamptz,
  CONSTRAINT marketing_atrib_campanha_fk FOREIGN KEY (empresa_id, campanha_id) REFERENCES marketing_campanhas (empresa_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT marketing_atrib_contato_fk FOREIGN KEY (empresa_id, contato_id) REFERENCES marketing_contatos (empresa_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT marketing_atrib_alvo CHECK (alvo_tipo IN ('CLIENTE', 'FECHAMENTO', 'CONTATO')),
  CONSTRAINT marketing_atrib_origem CHECK (origem_codigo ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  CONSTRAINT marketing_atrib_canal CHECK (canal_atendimento IS NULL OR canal_atendimento IN ('FORMULARIO_SITE', 'WHATSAPP', 'TELEFONE', 'PRESENCIAL', 'EMAIL', 'OUTRO')),
  CONSTRAINT marketing_atrib_metodo CHECK (metodo IN ('CAPTURADO', 'INFORMADO', 'HERDADO', 'DESCONHECIDO')),
  CONSTRAINT marketing_atrib_desconhecida CHECK ((origem_codigo = 'DESCONHECIDA') = (metodo = 'DESCONHECIDO')),
  CONSTRAINT marketing_atrib_capturada_tem_campanha CHECK (metodo <> 'CAPTURADO' OR campanha_id IS NOT NULL),
  CONSTRAINT marketing_atrib_detalhe CHECK (detalhe IS NULL OR char_length(detalhe) <= 200),
  CONSTRAINT marketing_atrib_utm CHECK (jsonb_typeof(utm) = 'object' AND octet_length(utm::text) <= 2000),
  CONSTRAINT marketing_atrib_correcao CHECK (substitui_id IS NULL OR (motivo IS NOT NULL AND char_length(btrim(motivo)) >= 3)),
  CONSTRAINT marketing_atrib_vigencia CHECK (vigente = (substituida_em IS NULL))
);
CREATE UNIQUE INDEX marketing_atrib_vigente_uk ON marketing_atribuicoes (empresa_id, alvo_tipo, alvo_id) WHERE vigente;
CREATE UNIQUE INDEX marketing_atrib_substitui_uk ON marketing_atribuicoes (substitui_id) WHERE substitui_id IS NOT NULL;
CREATE INDEX marketing_atrib_campanha_idx ON marketing_atribuicoes (empresa_id, campanha_id) WHERE vigente AND campanha_id IS NOT NULL;
CREATE INDEX marketing_atrib_alvo_idx ON marketing_atribuicoes (alvo_tipo, alvo_id, registrado_em);

CREATE FUNCTION kidmais083_atribuicao_controle() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_catalog, pg_temp AS $$
DECLARE dono uuid; anterior marketing_atribuicoes%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION '083: atribuição não é apagada; corrija com uma nova.'; END IF;
  IF TG_OP = 'UPDATE' THEN
    -- Só a desativação da vigente (correção), uma vez.
    IF NOT (OLD.vigente AND NOT NEW.vigente AND NEW.substituida_em IS NOT NULL)
       OR (to_jsonb(NEW) - 'vigente' - 'substituida_em') IS DISTINCT FROM (to_jsonb(OLD) - 'vigente' - 'substituida_em') THEN
      RAISE EXCEPTION '083: atribuição é append-only; só a vigente pode ser substituída.';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.alvo_tipo = 'CLIENTE' THEN SELECT empresa_id INTO dono FROM clientes WHERE id = NEW.alvo_id;
  ELSIF NEW.alvo_tipo = 'FECHAMENTO' THEN SELECT empresa_id INTO dono FROM fechamentos WHERE id = NEW.alvo_id;
  ELSE SELECT empresa_id INTO dono FROM marketing_contatos WHERE id = NEW.alvo_id;
  END IF;
  IF dono IS DISTINCT FROM NEW.empresa_id THEN RAISE EXCEPTION '083: alvo da atribuição inexistente ou de outra empresa.'; END IF;
  IF NEW.substitui_id IS NOT NULL THEN
    SELECT * INTO anterior FROM marketing_atribuicoes WHERE id = NEW.substitui_id;
    IF anterior.id IS NULL OR anterior.empresa_id <> NEW.empresa_id OR anterior.alvo_tipo <> NEW.alvo_tipo OR anterior.alvo_id <> NEW.alvo_id OR anterior.vigente THEN
      RAISE EXCEPTION '083: correção precisa substituir a atribuição (já desativada) do mesmo alvo.';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER marketing_atrib_controle BEFORE INSERT OR UPDATE OR DELETE ON marketing_atribuicoes
  FOR EACH ROW EXECUTE FUNCTION kidmais083_atribuicao_controle();

-- =============================================================================
-- 8. Eventos de clique (link de campanha, botão de WhatsApp). Sem IP nem dado pessoal. Não é contato.
-- =============================================================================
CREATE TABLE marketing_eventos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresas (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  site_id uuid,
  campanha_id uuid,
  tipo text NOT NULL,
  ocorrido_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT marketing_eventos_site_fk FOREIGN KEY (empresa_id, site_id) REFERENCES marketing_sites (empresa_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT marketing_eventos_campanha_fk FOREIGN KEY (empresa_id, campanha_id) REFERENCES marketing_campanhas (empresa_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT marketing_eventos_tipo CHECK (tipo IN ('CLIQUE_LINK_CAMPANHA', 'CLIQUE_WHATSAPP'))
);
CREATE INDEX marketing_eventos_periodo_idx ON marketing_eventos (empresa_id, ocorrido_em);
CREATE TRIGGER marketing_eventos_imutavel BEFORE UPDATE OR DELETE ON marketing_eventos
  FOR EACH ROW EXECUTE FUNCTION kidmais083_somente_insercao();

COMMENT ON TABLE marketing_atribuicoes IS
  'Origem de cliente (primeira = primeira linha), negociação e contato. Append-only: correção desativa a vigente e insere outra com motivo. DESCONHECIDA = sem evidência.';
COMMENT ON TABLE marketing_contatos IS
  'Pedidos captados (site) ou registrados manualmente. Não é negociação; o vínculo com fechamento é explícito. Nunca apagado.';
COMMENT ON TABLE marketing_site_versoes IS
  'Conteúdo publicado do site (imutável). O público lê só a versão apontada por marketing_sites.versao_publicada_id.';
COMMENT ON COLUMN marketing_dominios.simulado IS
  'true = provedor simulado (local). Domínio simulado nunca é apresentado como ativo real nem usado como canonical fora do modo local.';
COMMENT ON TABLE marketing_eventos IS
  'Cliques em link de campanha e no botão de WhatsApp. Clique não é contato, conversa nem lead confirmado.';

COMMIT;
