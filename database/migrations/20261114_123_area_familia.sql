-- =============================================================================
-- Kidmais Manager / iA.Fest — Migration 123: área "Minha festa" da família (F1, base de segurança)
-- Arquivo: 20261114_123_area_familia.sql — LOCAL, PREPARADA, não aplicada em staging nem em production.
--
-- Plano: vault "Area da familia proposta 20261114" (aprovado por Felipe em 14/11/2026, revisão do Fable incorporada).
-- 123 conferida livre em 14/11 (todos os clones locais e todas as origin/*); 122 é do Funil (local, outro clone).
--
--   1. festa_pessoas       — quem tem acesso à festa: CONTRATANTE (aponta para o cliente da festa; contato vem do
--                            cadastro, nada copiado) e no máximo um SEGUNDO_RESPONSAVEL ativo (nome, WhatsApp, e-mail
--                            opcional, HMAC do CPF opcional). Remoção lógica com autoria.
--   2. festa_links_area    — link pessoal por pessoa: só o SHA-256 do token (o token vai no fragmento da URL), prazo,
--                            revogação; um ativo por pessoa.
--   3. validacoes_identidade_cliente — finalidade AREA_FAMILIA, festa_pessoa_id (obrigatório só nela) e consumo pela
--                            sessão (consumido_por_area_sessao_id). Os cinco checks de estado/consumo da 010 recriados.
--   4. area_familia_sessoes — só o SHA-256 do cookie; pessoa, festa, empresa, "lembrar", prazo (teto 12 h sem lembrar,
--                            30 dias com), último uso, revogação com motivo, resumo do aparelho (sem IP).
--   5. limites_contadores  — contador por chave (HMAC calculado na aplicação; nunca IP ou CPF em claro) e janela fixa,
--                            incremento atômico: vale entre réplicas.
--   6. area_familia_eventos — auditoria sem dado pessoal (quem fez o quê, quando).
--   7. Gatilhos: coerência pessoa × festa × empresa × cliente; prova ⇄ sessão; queda das sessões quando muda o WhatsApp
--      ou o e-mail (cliente ou pessoa), a pessoa é removida, o contrato é cancelado ou a festa é invalidada.
--
-- Aditiva para os dados existentes: nenhuma linha antiga muda; os checks recriados aceitam exatamente o que os da 010
-- aceitavam quando consumido_por_area_sessao_id é nulo. Rollback: database/rollback/20261114_123_area_familia_down.sql
-- (recusa se houver qualquer pessoa, link, sessão ou validação AREA_FAMILIA).
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;

DO $$
BEGIN
  IF to_regclass('public.festas') IS NULL OR to_regclass('public.contratos') IS NULL OR to_regclass('public.fechamentos') IS NULL
     OR to_regclass('public.pacotes') IS NULL OR to_regclass('public.clientes') IS NULL OR to_regclass('public.empresas') IS NULL
     OR to_regclass('public.usuarios_administrativos') IS NULL OR to_regclass('public.validacoes_identidade_cliente') IS NULL THEN
    RAISE EXCEPTION '123: pré-requisito ausente (festas, contratos, fechamentos, pacotes, clientes, empresas, usuarios_administrativos, validacoes_identidade_cliente).';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'pacotes' AND column_name = 'empresa_id') THEN
    RAISE EXCEPTION '123: pacotes.empresa_id ausente.';
  END IF;
  IF to_regclass('public.festa_pessoas') IS NOT NULL OR to_regclass('public.festa_links_area') IS NOT NULL
     OR to_regclass('public.area_familia_sessoes') IS NOT NULL OR to_regclass('public.limites_contadores') IS NOT NULL
     OR to_regclass('public.area_familia_eventos') IS NOT NULL
     OR EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'validacoes_identidade_cliente'
                 AND column_name IN ('festa_pessoa_id', 'consumido_por_area_sessao_id')) THEN
    RAISE EXCEPTION '123: já (parcialmente) presente.';
  END IF;
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'validacoes_identidade_cliente_finalidade_check')
     NOT LIKE '%FECHAMENTO_PUBLICO%CONTRATO_ACEITE%' THEN
    RAISE EXCEPTION '123: finalidade de validacoes_identidade_cliente fora do formato da 010.';
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 1. Pessoas da festa
-- -----------------------------------------------------------------------------
CREATE TABLE festa_pessoas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  festa_id uuid NOT NULL REFERENCES festas(id) ON DELETE RESTRICT,
  empresa_id uuid NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  papel text NOT NULL CHECK (papel IN ('CONTRATANTE', 'SEGUNDO_RESPONSAVEL')),
  cliente_id uuid REFERENCES clientes(id) ON DELETE RESTRICT,
  nome text,
  whatsapp text,
  email text,
  documento_hash char(64),
  criado_por_usuario_id uuid REFERENCES usuarios_administrativos(id) ON DELETE RESTRICT,
  criado_por_pessoa_id uuid,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  removido_em timestamptz,
  removido_por_usuario_id uuid REFERENCES usuarios_administrativos(id) ON DELETE RESTRICT,
  removido_por_pessoa_id uuid,
  CONSTRAINT festa_pessoas_id_festa_empresa_uk UNIQUE (id, festa_id, empresa_id),
  CONSTRAINT festa_pessoas_criado_pessoa_fk FOREIGN KEY (criado_por_pessoa_id) REFERENCES festa_pessoas(id) ON DELETE RESTRICT,
  CONSTRAINT festa_pessoas_removido_pessoa_fk FOREIGN KEY (removido_por_pessoa_id) REFERENCES festa_pessoas(id) ON DELETE RESTRICT,
  -- Contratante: só o vínculo com o cliente; o contato é sempre o ATUAL do cadastro (nada copiado).
  CONSTRAINT festa_pessoas_contratante_check CHECK (
    papel <> 'CONTRATANTE' OR (cliente_id IS NOT NULL AND num_nonnulls(nome, whatsapp, email, documento_hash) = 0)),
  -- Segundo responsável: não é cliente do buffet; nome e WhatsApp próprios (o código vai só para ele).
  CONSTRAINT festa_pessoas_segundo_check CHECK (
    papel <> 'SEGUNDO_RESPONSAVEL' OR (cliente_id IS NULL AND nome IS NOT NULL AND length(btrim(nome)) BETWEEN 2 AND 120
      AND whatsapp IS NOT NULL AND whatsapp ~ '^[0-9]{10,13}$')),
  CONSTRAINT festa_pessoas_email_check CHECK (email IS NULL OR (length(email) <= 254 AND email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')),
  CONSTRAINT festa_pessoas_documento_hash_check CHECK (documento_hash IS NULL OR documento_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT festa_pessoas_autoria_check CHECK (num_nonnulls(criado_por_usuario_id, criado_por_pessoa_id) = 1),
  CONSTRAINT festa_pessoas_remocao_check CHECK (
    (removido_em IS NULL AND removido_por_usuario_id IS NULL AND removido_por_pessoa_id IS NULL)
    OR (removido_em IS NOT NULL AND num_nonnulls(removido_por_usuario_id, removido_por_pessoa_id) = 1)),
  -- O contratante nunca é removido (a área dele cai com o contrato ou a festa).
  CONSTRAINT festa_pessoas_contratante_nao_removido_check CHECK (papel <> 'CONTRATANTE' OR removido_em IS NULL)
);
CREATE UNIQUE INDEX festa_pessoas_papel_ativo_uk ON festa_pessoas (festa_id, papel) WHERE removido_em IS NULL;
CREATE INDEX festa_pessoas_cliente_idx ON festa_pessoas (cliente_id) WHERE cliente_id IS NOT NULL;
CREATE TRIGGER festa_pessoas_atualizado_em_trg BEFORE UPDATE ON festa_pessoas
  FOR EACH ROW EXECUTE FUNCTION kidmais_set_atualizado_em();

-- Empresa da festa pelo mesmo predicado de tenant do painel: festa → contrato → fechamento → pacote.empresa_id.
CREATE FUNCTION kidmais_123_empresa_da_festa(p_festa uuid) RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT pac.empresa_id FROM festas f
    JOIN contratos c ON c.id = f.contrato_id
    JOIN fechamentos fe ON fe.id = c.fechamento_id
    JOIN pacotes pac ON pac.id = fe.pacote_id
   WHERE f.id = p_festa
$$;

CREATE FUNCTION kidmais_123_festa_pessoas_validar() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cliente_festa uuid; autor_festa uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.festa_id IS DISTINCT FROM OLD.festa_id OR NEW.empresa_id IS DISTINCT FROM OLD.empresa_id OR NEW.papel IS DISTINCT FROM OLD.papel
       OR NEW.cliente_id IS DISTINCT FROM OLD.cliente_id OR NEW.criado_por_usuario_id IS DISTINCT FROM OLD.criado_por_usuario_id
       OR NEW.criado_por_pessoa_id IS DISTINCT FROM OLD.criado_por_pessoa_id OR NEW.criado_em IS DISTINCT FROM OLD.criado_em THEN
      RAISE EXCEPTION '123: festa, empresa, papel, cliente e autoria da pessoa são imutáveis' USING ERRCODE = '23514';
    END IF;
    IF OLD.removido_em IS NOT NULL AND (NEW.removido_em IS DISTINCT FROM OLD.removido_em OR NEW.nome IS DISTINCT FROM OLD.nome
       OR NEW.whatsapp IS DISTINCT FROM OLD.whatsapp OR NEW.email IS DISTINCT FROM OLD.email OR NEW.documento_hash IS DISTINCT FROM OLD.documento_hash) THEN
      RAISE EXCEPTION '123: pessoa removida não volta nem muda' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.empresa_id IS DISTINCT FROM kidmais_123_empresa_da_festa(NEW.festa_id) THEN
    RAISE EXCEPTION '123: empresa da pessoa difere da empresa da festa' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM festas WHERE id = NEW.festa_id AND invalidada_em IS NOT NULL) THEN
    RAISE EXCEPTION '123: festa invalidada não recebe pessoas' USING ERRCODE = '23514';
  END IF;
  IF NEW.papel = 'CONTRATANTE' THEN
    SELECT fe.cliente_id INTO cliente_festa FROM festas f JOIN contratos c ON c.id = f.contrato_id
      JOIN fechamentos fe ON fe.id = c.fechamento_id WHERE f.id = NEW.festa_id;
    IF cliente_festa IS NULL OR cliente_festa IS DISTINCT FROM NEW.cliente_id THEN
      RAISE EXCEPTION '123: o contratante precisa ser o cliente da festa' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.criado_por_pessoa_id IS NOT NULL THEN
    SELECT festa_id INTO autor_festa FROM festa_pessoas WHERE id = NEW.criado_por_pessoa_id AND papel = 'CONTRATANTE' AND removido_em IS NULL;
    IF autor_festa IS DISTINCT FROM NEW.festa_id THEN
      RAISE EXCEPTION '123: só o contratante da mesma festa cadastra pessoas' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER festa_pessoas_validar_trg BEFORE INSERT OR UPDATE ON festa_pessoas
  FOR EACH ROW EXECUTE FUNCTION kidmais_123_festa_pessoas_validar();

-- -----------------------------------------------------------------------------
-- 2. Links pessoais
-- -----------------------------------------------------------------------------
CREATE TABLE festa_links_area (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pessoa_id uuid NOT NULL,
  festa_id uuid NOT NULL,
  empresa_id uuid NOT NULL,
  token_hash char(64) NOT NULL,
  expira_em timestamptz NOT NULL,
  criado_em timestamptz NOT NULL DEFAULT now(),
  criado_por_usuario_id uuid REFERENCES usuarios_administrativos(id) ON DELETE RESTRICT,
  criado_por_pessoa_id uuid REFERENCES festa_pessoas(id) ON DELETE RESTRICT,
  revogado_em timestamptz,
  motivo_revogacao text,
  CONSTRAINT festa_links_area_pessoa_fk FOREIGN KEY (pessoa_id, festa_id, empresa_id)
    REFERENCES festa_pessoas (id, festa_id, empresa_id) ON DELETE RESTRICT,
  CONSTRAINT festa_links_area_token_hash_check CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT festa_links_area_prazo_check CHECK (expira_em > criado_em AND expira_em <= criado_em + interval '400 days'),
  CONSTRAINT festa_links_area_autoria_check CHECK (num_nonnulls(criado_por_usuario_id, criado_por_pessoa_id) = 1),
  CONSTRAINT festa_links_area_revogacao_check CHECK (
    (revogado_em IS NULL AND motivo_revogacao IS NULL)
    OR (revogado_em IS NOT NULL AND motivo_revogacao IN ('NOVO_LINK', 'BUFFET_REVOGOU', 'PESSOA_REMOVIDA', 'CONTRATO_CANCELADO', 'FESTA_INVALIDADA')))
);
CREATE UNIQUE INDEX festa_links_area_token_uk ON festa_links_area (token_hash);
CREATE UNIQUE INDEX festa_links_area_ativo_uk ON festa_links_area (pessoa_id) WHERE revogado_em IS NULL;

-- -----------------------------------------------------------------------------
-- 3. Sessões
-- -----------------------------------------------------------------------------
CREATE TABLE area_familia_sessoes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pessoa_id uuid NOT NULL,
  festa_id uuid NOT NULL,
  empresa_id uuid NOT NULL,
  validacao_id uuid NOT NULL REFERENCES validacoes_identidade_cliente(id) ON DELETE RESTRICT,
  token_hash char(64) NOT NULL,
  lembrar boolean NOT NULL,
  criado_em timestamptz NOT NULL DEFAULT now(),
  expira_em timestamptz NOT NULL,
  ultimo_uso_em timestamptz NOT NULL DEFAULT now(),
  revogada_em timestamptz,
  motivo_revogacao text,
  aparelho text,
  CONSTRAINT area_familia_sessoes_pessoa_fk FOREIGN KEY (pessoa_id, festa_id, empresa_id)
    REFERENCES festa_pessoas (id, festa_id, empresa_id) ON DELETE RESTRICT,
  CONSTRAINT area_familia_sessoes_token_hash_check CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  -- Sem "lembrar": teto de 12 h no servidor (o cookie vale até fechar o navegador). Com "lembrar": até 30 dias.
  CONSTRAINT area_familia_sessoes_prazo_check CHECK (
    expira_em > criado_em AND expira_em <= criado_em + CASE WHEN lembrar THEN interval '30 days' ELSE interval '12 hours' END),
  CONSTRAINT area_familia_sessoes_revogacao_check CHECK (
    (revogada_em IS NULL AND motivo_revogacao IS NULL)
    OR (revogada_em IS NOT NULL AND motivo_revogacao IN ('SAIR', 'SAIR_DE_TODOS', 'BUFFET_DESCONECTOU', 'CONTATO_ALTERADO',
        'PESSOA_REMOVIDA', 'CONTRATO_CANCELADO', 'FESTA_INVALIDADA'))),
  CONSTRAINT area_familia_sessoes_aparelho_check CHECK (aparelho IS NULL OR length(aparelho) <= 80)
);
CREATE UNIQUE INDEX area_familia_sessoes_token_uk ON area_familia_sessoes (token_hash);
CREATE UNIQUE INDEX area_familia_sessoes_validacao_uk ON area_familia_sessoes (validacao_id);
CREATE INDEX area_familia_sessoes_pessoa_ativa_idx ON area_familia_sessoes (pessoa_id) WHERE revogada_em IS NULL;
CREATE INDEX area_familia_sessoes_festa_ativa_idx ON area_familia_sessoes (festa_id) WHERE revogada_em IS NULL;
CREATE INDEX area_familia_sessoes_expira_idx ON area_familia_sessoes (expira_em);

-- -----------------------------------------------------------------------------
-- 4. Validação de identidade: finalidade AREA_FAMILIA e consumo pela sessão
-- -----------------------------------------------------------------------------
ALTER TABLE validacoes_identidade_cliente
  ADD COLUMN festa_pessoa_id uuid REFERENCES festa_pessoas(id) ON DELETE RESTRICT,
  ADD COLUMN consumido_por_area_sessao_id uuid REFERENCES area_familia_sessoes(id) ON DELETE RESTRICT;

ALTER TABLE validacoes_identidade_cliente
  DROP CONSTRAINT validacoes_identidade_cliente_finalidade_check,
  DROP CONSTRAINT validacoes_identidade_cliente_pendente_check,
  DROP CONSTRAINT validacoes_identidade_cliente_recuperacao_check,
  DROP CONSTRAINT validacoes_identidade_cliente_confirmada_check,
  DROP CONSTRAINT validacoes_identidade_cliente_consumida_check,
  DROP CONSTRAINT validacoes_identidade_cliente_consumo_consistencia,
  DROP CONSTRAINT validacoes_identidade_cliente_consumidor_finalidade_check;

ALTER TABLE validacoes_identidade_cliente
  ADD CONSTRAINT validacoes_identidade_cliente_finalidade_check CHECK (
    finalidade IN ('FECHAMENTO_PUBLICO', 'CONTRATO_ACEITE', 'AREA_FAMILIA')),
  -- A pessoa da festa existe exatamente na finalidade da área. A área nunca tem recuperação nem prova solta
  -- (CONFIRMADA): o código certo vira sessão no mesmo commit (PENDENTE → CONSUMIDA), então nenhuma prova da área pode
  -- ser usada pelos fluxos de fechamento ou de contrato.
  ADD CONSTRAINT validacoes_identidade_cliente_pessoa_area_check CHECK (
    (finalidade = 'AREA_FAMILIA') = (festa_pessoa_id IS NOT NULL)
    AND (finalidade <> 'AREA_FAMILIA' OR status NOT IN ('RECUPERACAO_PENDENTE', 'CONFIRMADA'))),
  ADD CONSTRAINT validacoes_identidade_cliente_pendente_check CHECK (
    status <> 'PENDENTE' OR (
      canal IS NOT NULL AND codigo_hash IS NOT NULL AND codigo_expira_em IS NOT NULL
      AND confirmado_em IS NULL AND token_prova_hash IS NULL AND prova_expira_em IS NULL
      AND consumido_em IS NULL AND consumido_por_fechamento_id IS NULL AND consumido_por_contrato_versao_id IS NULL
      AND consumido_por_area_sessao_id IS NULL AND recuperacao_solicitada_em IS NULL)),
  ADD CONSTRAINT validacoes_identidade_cliente_recuperacao_check CHECK (
    status <> 'RECUPERACAO_PENDENTE' OR (
      codigo_hash IS NULL AND codigo_expira_em IS NULL AND confirmado_em IS NULL AND token_prova_hash IS NULL
      AND prova_expira_em IS NULL AND consumido_em IS NULL AND consumido_por_fechamento_id IS NULL
      AND consumido_por_contrato_versao_id IS NULL AND consumido_por_area_sessao_id IS NULL
      AND recuperacao_solicitada_em IS NOT NULL)),
  ADD CONSTRAINT validacoes_identidade_cliente_confirmada_check CHECK (
    status <> 'CONFIRMADA' OR (
      canal IS NOT NULL AND confirmado_em IS NOT NULL AND token_prova_hash IS NOT NULL AND prova_expira_em IS NOT NULL
      AND consumido_em IS NULL AND consumido_por_fechamento_id IS NULL AND consumido_por_contrato_versao_id IS NULL
      AND consumido_por_area_sessao_id IS NULL)),
  ADD CONSTRAINT validacoes_identidade_cliente_consumida_check CHECK (
    status <> 'CONSUMIDA' OR (
      confirmado_em IS NOT NULL AND token_prova_hash IS NOT NULL AND prova_expira_em IS NOT NULL AND consumido_em IS NOT NULL
      AND num_nonnulls(consumido_por_fechamento_id, consumido_por_contrato_versao_id, consumido_por_area_sessao_id) = 1)),
  ADD CONSTRAINT validacoes_identidade_cliente_consumo_consistencia CHECK (
    (consumido_em IS NULL AND num_nonnulls(consumido_por_fechamento_id, consumido_por_contrato_versao_id, consumido_por_area_sessao_id) = 0)
    OR (consumido_em IS NOT NULL AND num_nonnulls(consumido_por_fechamento_id, consumido_por_contrato_versao_id, consumido_por_area_sessao_id) = 1)),
  ADD CONSTRAINT validacoes_identidade_cliente_consumidor_finalidade_check CHECK (
    (finalidade = 'FECHAMENTO_PUBLICO' AND consumido_por_contrato_versao_id IS NULL AND consumido_por_area_sessao_id IS NULL)
    OR (finalidade = 'CONTRATO_ACEITE' AND consumido_por_fechamento_id IS NULL AND consumido_por_area_sessao_id IS NULL)
    OR (finalidade = 'AREA_FAMILIA' AND consumido_por_fechamento_id IS NULL AND consumido_por_contrato_versao_id IS NULL));

CREATE UNIQUE INDEX validacoes_identidade_cliente_area_sessao_uk
  ON validacoes_identidade_cliente (consumido_por_area_sessao_id) WHERE consumido_por_area_sessao_id IS NOT NULL;
CREATE INDEX validacoes_identidade_cliente_pessoa_idx
  ON validacoes_identidade_cliente (festa_pessoa_id, criado_em DESC) WHERE festa_pessoa_id IS NOT NULL;

-- A prova da validação AREA_FAMILIA é da pessoa e do cliente da festa dela; não troca de pessoa depois de criada.
CREATE FUNCTION kidmais_123_validacao_area_coerente() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p festa_pessoas%ROWTYPE; cliente_festa uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.festa_pessoa_id IS DISTINCT FROM OLD.festa_pessoa_id OR NEW.finalidade IS DISTINCT FROM OLD.finalidade
     OR NEW.cliente_id IS DISTINCT FROM OLD.cliente_id) AND (OLD.finalidade = 'AREA_FAMILIA' OR NEW.finalidade = 'AREA_FAMILIA') THEN
    RAISE EXCEPTION '123: pessoa, cliente e finalidade da validação da área são imutáveis' USING ERRCODE = '23514';
  END IF;
  IF NEW.festa_pessoa_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO p FROM festa_pessoas WHERE id = NEW.festa_pessoa_id;
  SELECT fe.cliente_id INTO cliente_festa FROM festas f JOIN contratos c ON c.id = f.contrato_id
    JOIN fechamentos fe ON fe.id = c.fechamento_id WHERE f.id = p.festa_id;
  IF p.id IS NULL OR cliente_festa IS DISTINCT FROM NEW.cliente_id THEN
    RAISE EXCEPTION '123: validação da área fora da festa da pessoa' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' AND p.removido_em IS NOT NULL THEN
    RAISE EXCEPTION '123: pessoa removida não recebe código' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER validacoes_identidade_cliente_area_trg BEFORE INSERT OR UPDATE ON validacoes_identidade_cliente
  FOR EACH ROW EXECUTE FUNCTION kidmais_123_validacao_area_coerente();

-- Sessão nasce de uma prova AREA_FAMILIA da MESMA pessoa, consumida por ela, no mesmo commit (diferido).
CREATE FUNCTION kidmais_123_sessao_exige_prova() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v validacoes_identidade_cliente%ROWTYPE;
BEGIN
  SELECT * INTO v FROM validacoes_identidade_cliente WHERE id = NEW.validacao_id;
  IF v.id IS NULL OR v.finalidade <> 'AREA_FAMILIA' OR v.status <> 'CONSUMIDA' OR v.festa_pessoa_id IS DISTINCT FROM NEW.pessoa_id
     OR v.consumido_por_area_sessao_id IS DISTINCT FROM NEW.id THEN
    RAISE EXCEPTION '123: sessão sem prova AREA_FAMILIA consumida pela própria pessoa' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER area_familia_sessoes_prova_trg AFTER INSERT ON area_familia_sessoes
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kidmais_123_sessao_exige_prova();

-- Sessão: só o uso, o prazo (encurtar) e a revogação mudam; revogada não volta.
CREATE FUNCTION kidmais_123_sessao_imutavel() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.pessoa_id IS DISTINCT FROM OLD.pessoa_id OR NEW.festa_id IS DISTINCT FROM OLD.festa_id
     OR NEW.empresa_id IS DISTINCT FROM OLD.empresa_id OR NEW.validacao_id IS DISTINCT FROM OLD.validacao_id
     OR NEW.token_hash IS DISTINCT FROM OLD.token_hash OR NEW.lembrar IS DISTINCT FROM OLD.lembrar
     OR NEW.criado_em IS DISTINCT FROM OLD.criado_em OR NEW.expira_em > OLD.expira_em
     OR (OLD.revogada_em IS NOT NULL AND (NEW.revogada_em IS DISTINCT FROM OLD.revogada_em OR NEW.motivo_revogacao IS DISTINCT FROM OLD.motivo_revogacao)) THEN
    RAISE EXCEPTION '123: sessão da área só registra uso e revogação' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER area_familia_sessoes_imutavel_trg BEFORE UPDATE ON area_familia_sessoes
  FOR EACH ROW EXECUTE FUNCTION kidmais_123_sessao_imutavel();

-- -----------------------------------------------------------------------------
-- 5. Limites no banco (entre réplicas)
-- -----------------------------------------------------------------------------
CREATE TABLE limites_contadores (
  chave char(64) NOT NULL,
  janela_inicio timestamptz NOT NULL,
  usados integer NOT NULL CHECK (usados > 0),
  expira_em timestamptz NOT NULL,
  PRIMARY KEY (chave, janela_inicio),
  CONSTRAINT limites_contadores_chave_check CHECK (chave ~ '^[0-9a-f]{64}$'),
  CONSTRAINT limites_contadores_janela_check CHECK (expira_em > janela_inicio AND expira_em <= janela_inicio + interval '2 days')
);
CREATE INDEX limites_contadores_expira_idx ON limites_contadores (expira_em);

-- -----------------------------------------------------------------------------
-- 6. Auditoria sem dado pessoal
-- -----------------------------------------------------------------------------
CREATE TABLE area_familia_eventos (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  festa_id uuid NOT NULL REFERENCES festas(id) ON DELETE RESTRICT,
  empresa_id uuid NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  pessoa_id uuid REFERENCES festa_pessoas(id) ON DELETE RESTRICT,
  autor_usuario_id uuid REFERENCES usuarios_administrativos(id) ON DELETE RESTRICT,
  autor_pessoa_id uuid REFERENCES festa_pessoas(id) ON DELETE RESTRICT,
  tipo text NOT NULL CHECK (tipo IN ('LINK_GERADO', 'LINK_REVOGADO', 'ENTRADA', 'SAIR', 'SAIR_DE_TODOS', 'BUFFET_DESCONECTOU',
    'PESSOA_CADASTRADA', 'PESSOA_REMOVIDA', 'CONTATO_ALTERADO', 'SESSOES_DERRUBADAS')),
  motivo text CHECK (motivo IS NULL OR motivo ~ '^[A-Z_]{3,40}$'),
  criado_em timestamptz NOT NULL DEFAULT now(),
  -- Nenhum autor só é aceito para quedas automáticas (gatilhos).
  CONSTRAINT area_familia_eventos_autor_check CHECK (num_nonnulls(autor_usuario_id, autor_pessoa_id) <= 1
    AND (tipo = 'SESSOES_DERRUBADAS' OR num_nonnulls(autor_usuario_id, autor_pessoa_id) = 1))
);
CREATE INDEX area_familia_eventos_festa_idx ON area_familia_eventos (festa_id, criado_em DESC);

CREATE FUNCTION kidmais_123_eventos_somente_acrescimo() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '123: auditoria da área só recebe acréscimos' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER area_familia_eventos_somente_acrescimo_trg BEFORE UPDATE OR DELETE ON area_familia_eventos
  FOR EACH ROW EXECUTE FUNCTION kidmais_123_eventos_somente_acrescimo();

-- -----------------------------------------------------------------------------
-- 7. Quedas automáticas
-- -----------------------------------------------------------------------------
-- Revoga as sessões ativas das pessoas (todas da festa, quando p_pessoa é nulo) e registra um evento por festa.
CREATE FUNCTION kidmais_123_derrubar_sessoes(p_festa uuid, p_pessoa uuid, p_motivo text) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE n integer; emp uuid;
BEGIN
  UPDATE area_familia_sessoes SET revogada_em = clock_timestamp(), motivo_revogacao = p_motivo
   WHERE festa_id = p_festa AND revogada_em IS NULL AND (p_pessoa IS NULL OR pessoa_id = p_pessoa);
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    SELECT empresa_id INTO emp FROM festa_pessoas WHERE festa_id = p_festa LIMIT 1;
    INSERT INTO area_familia_eventos (festa_id, empresa_id, pessoa_id, tipo, motivo) VALUES (p_festa, emp, p_pessoa, 'SESSOES_DERRUBADAS', p_motivo);
  END IF;
  RETURN n;
END $$;

CREATE FUNCTION kidmais_123_revogar_links(p_festa uuid, p_pessoa uuid, p_motivo text) RETURNS void LANGUAGE sql AS $$
  UPDATE festa_links_area SET revogado_em = clock_timestamp(), motivo_revogacao = p_motivo
   WHERE festa_id = p_festa AND revogado_em IS NULL AND (p_pessoa IS NULL OR pessoa_id = p_pessoa)
$$;

-- Encerra os códigos AREA_FAMILIA ainda pendentes da pessoa (AF-R1): código enviado ao contato antigo não abre sessão.
CREATE FUNCTION kidmais_123_cancelar_codigos(p_pessoa uuid) RETURNS void LANGUAGE sql AS $$
  UPDATE validacoes_identidade_cliente SET status = 'CANCELADA'
   WHERE festa_pessoa_id = p_pessoa AND finalidade = 'AREA_FAMILIA' AND status = 'PENDENTE'
$$;

-- Cliente: muda o WhatsApp ou o e-mail ⇒ caem as sessões e os códigos pendentes do contratante em todas as festas dele.
CREATE FUNCTION kidmais_123_cliente_contato_alterado() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
  IF NEW.whatsapp IS DISTINCT FROM OLD.whatsapp OR NEW.email IS DISTINCT FROM OLD.email THEN
    FOR r IN SELECT id, festa_id FROM festa_pessoas WHERE cliente_id = NEW.id AND papel = 'CONTRATANTE' LOOP
      PERFORM kidmais_123_cancelar_codigos(r.id);
      PERFORM kidmais_123_derrubar_sessoes(r.festa_id, r.id, 'CONTATO_ALTERADO');
    END LOOP;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER clientes_123_contato_alterado_trg AFTER UPDATE OF whatsapp, email ON clientes
  FOR EACH ROW EXECUTE FUNCTION kidmais_123_cliente_contato_alterado();

-- Pessoa: muda o WhatsApp ou o e-mail ⇒ caem as sessões e os códigos pendentes dela; muda o documento ⇒ caem os códigos
-- pendentes; removida ⇒ caem sessões, códigos e links.
CREATE FUNCTION kidmais_123_pessoa_alterada() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.removido_em IS NOT NULL AND OLD.removido_em IS NULL THEN
    PERFORM kidmais_123_cancelar_codigos(NEW.id);
    PERFORM kidmais_123_derrubar_sessoes(NEW.festa_id, NEW.id, 'PESSOA_REMOVIDA');
    PERFORM kidmais_123_revogar_links(NEW.festa_id, NEW.id, 'PESSOA_REMOVIDA');
  ELSIF NEW.whatsapp IS DISTINCT FROM OLD.whatsapp OR NEW.email IS DISTINCT FROM OLD.email THEN
    PERFORM kidmais_123_cancelar_codigos(NEW.id);
    PERFORM kidmais_123_derrubar_sessoes(NEW.festa_id, NEW.id, 'CONTATO_ALTERADO');
  ELSIF NEW.documento_hash IS DISTINCT FROM OLD.documento_hash THEN
    PERFORM kidmais_123_cancelar_codigos(NEW.id);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER festa_pessoas_123_alterada_trg AFTER UPDATE ON festa_pessoas
  FOR EACH ROW EXECUTE FUNCTION kidmais_123_pessoa_alterada();

-- Contrato cancelado ⇒ caem as sessões, os códigos pendentes e os links de todas as festas dele.
CREATE FUNCTION kidmais_123_contrato_cancelado() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
  IF NEW.status = 'CANCELADO' AND OLD.status IS DISTINCT FROM 'CANCELADO' THEN
    PERFORM kidmais_123_cancelar_codigos(p.id) FROM festa_pessoas p JOIN festas f ON f.id = p.festa_id WHERE f.contrato_id = NEW.id;
    FOR r IN SELECT id FROM festas WHERE contrato_id = NEW.id LOOP
      PERFORM kidmais_123_derrubar_sessoes(r.id, NULL, 'CONTRATO_CANCELADO');
      PERFORM kidmais_123_revogar_links(r.id, NULL, 'CONTRATO_CANCELADO');
    END LOOP;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER contratos_123_cancelado_trg AFTER UPDATE OF status ON contratos
  FOR EACH ROW EXECUTE FUNCTION kidmais_123_contrato_cancelado();

-- Festa invalidada: SEM gatilho em `festas`. Um gatilho lá muda a assinatura de estrutura que o módulo Festa confere
-- (lib/festas/estrutura-016.ts) e o deixaria indisponível. O acesso fecha na hora mesmo assim: toda leitura de sessão,
-- link e código exige f.invalidada_em IS NULL (SQL_ACESSO_ABERTO em lib/area-familia/acesso.ts).

COMMENT ON TABLE festa_pessoas IS '123: pessoas com acesso à área Minha festa (contratante e segundo responsável).';
COMMENT ON TABLE area_familia_sessoes IS '123: sessões da área Minha festa; só o SHA-256 do cookie.';
COMMENT ON TABLE limites_contadores IS '123: limites de tentativas compartilhados entre réplicas; chave = HMAC da aplicação.';

COMMIT;
