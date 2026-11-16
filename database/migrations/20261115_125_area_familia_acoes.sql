-- =============================================================================
-- Kidmais Manager / iA.Fest — Migration 125: ações da área "Minha festa" (F3)
-- Arquivo: 20261115_125_area_familia_acoes.sql — LOCAL, PREPARADA, não aplicada em staging nem em production.
--
-- Plano: vault "Area da familia proposta 20261114", seção "Modelo da F3". 125 conferida livre em 15/11/2026 (staging
-- fc3e857f tem 123 e 124; nenhuma origin/*, clone local ou nota usa 125). Exige a 123.
--
--   1. area_familia_avisos_pagamento — "Já paguei: avisar o buffet": a pessoa avisa uma parcela do contrato da festa; a
--      equipe confere ou descarta. Não dá baixa (a baixa continua no financeiro, pela equipe).
--   2. festa_pendencias_familia — o que a família vê de uma pendência CLIENTE: visível sim/não, texto PARA A FAMÍLIA (a
--      descrição interna nunca vai para a área), "feito" pela família e "devolvido" pela equipe.
--   3. area_familia_aviso_empresa — um aviso fixo por buffet (ou nenhum).
--   4. area_familia_eventos — tipos novos (CHECK recriado com os da 123 + os da 125) e autoria conferida no INSERT.
--   5. Autoria pela família que a 123 não conferia: remoção de pessoa e link gerado por pessoa só pelo contratante ativo
--      da mesma festa, e só para o segundo responsável.
--
-- POR QUE TABELAS PRÓPRIAS: lib/festas/estrutura-016.ts assina colunas, restrições, índices, gatilhos e funções das
-- tabelas da Festa (festa_pendencias incluída). Coluna ou gatilho novo ali deixaria o módulo Festa em 503. As FKs daqui
-- para festa_pendencias pertencem às tabelas novas (pg_constraint.conrelid) e os gatilhos de RI são internos: a
-- assinatura não muda. Esta migration não altera nenhuma tabela da Festa.
--
-- Aditiva: nenhuma linha antiga muda. Rollback: database/rollback/20261115_125_area_familia_acoes_down.sql (recusa se
-- houver aviso, pendência configurada, aviso fixo ou evento de tipo da 125).
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;

DO $$
BEGIN
  IF to_regclass('public.festa_pessoas') IS NULL OR to_regclass('public.festa_links_area') IS NULL
     OR to_regclass('public.area_familia_eventos') IS NULL OR to_regprocedure('public.kidmais_123_empresa_da_festa(uuid)') IS NULL THEN
    RAISE EXCEPTION '125: exige a 123 (área Minha festa).';
  END IF;
  IF to_regclass('public.festa_pendencias') IS NULL OR to_regclass('public.pagamento_parcelas') IS NULL
     OR to_regclass('public.pagamento_planos') IS NULL OR to_regclass('public.pagamentos') IS NULL
     OR to_regclass('public.contrato_versoes') IS NULL OR to_regprocedure('public.kidmais_set_atualizado_em()') IS NULL THEN
    RAISE EXCEPTION '125: pré-requisito ausente (festa_pendencias, pagamentos, contrato_versoes, kidmais_set_atualizado_em).';
  END IF;
  IF to_regclass('public.area_familia_avisos_pagamento') IS NOT NULL OR to_regclass('public.festa_pendencias_familia') IS NOT NULL
     OR to_regclass('public.area_familia_aviso_empresa') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname LIKE 'kidmais_125_%') THEN
    RAISE EXCEPTION '125: já (parcialmente) presente.';
  END IF;
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint
       WHERE conrelid = 'public.area_familia_eventos'::regclass AND conname = 'area_familia_eventos_tipo_check') IS DISTINCT FROM
     'CHECK ((tipo = ANY (ARRAY[''LINK_GERADO''::text, ''LINK_REVOGADO''::text, ''ENTRADA''::text, ''SAIR''::text, ''SAIR_DE_TODOS''::text, ''BUFFET_DESCONECTOU''::text, ''PESSOA_CADASTRADA''::text, ''PESSOA_REMOVIDA''::text, ''CONTATO_ALTERADO''::text, ''SESSOES_DERRUBADAS''::text])))' THEN
    RAISE EXCEPTION '125: CHECK de area_familia_eventos.tipo fora do formato da 123.';
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- Pessoa ativa da festa (qualquer papel) — usada pelas três tabelas.
-- -----------------------------------------------------------------------------
CREATE FUNCTION kidmais_125_pessoa_ativa(p_pessoa uuid, p_festa uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM festa_pessoas WHERE id = p_pessoa AND festa_id = p_festa AND removido_em IS NULL)
$$;

-- Contratante ativo da festa.
CREATE FUNCTION kidmais_125_contratante_ativo(p_pessoa uuid, p_festa uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM festa_pessoas WHERE id = p_pessoa AND festa_id = p_festa AND papel = 'CONTRATANTE' AND removido_em IS NULL)
$$;

-- -----------------------------------------------------------------------------
-- 1. "Já paguei: avisar o buffet"
-- -----------------------------------------------------------------------------
CREATE TABLE area_familia_avisos_pagamento (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  festa_id uuid NOT NULL,
  empresa_id uuid NOT NULL,
  pessoa_id uuid NOT NULL,
  parcela_id uuid NOT NULL REFERENCES pagamento_parcelas(id) ON DELETE RESTRICT,
  parcela_numero smallint NOT NULL CHECK (parcela_numero > 0),
  saldo_centavos bigint NOT NULL CHECK (saldo_centavos > 0 AND saldo_centavos <= 100000000000),
  observacao text CHECK (observacao IS NULL OR (length(btrim(observacao)) BETWEEN 1 AND 280 AND observacao = btrim(observacao))),
  estado text NOT NULL DEFAULT 'PENDENTE' CHECK (estado IN ('PENDENTE', 'CONFERIDO', 'DESCARTADO')),
  criado_em timestamptz NOT NULL DEFAULT now(),
  tratado_em timestamptz,
  tratado_por_usuario_id uuid REFERENCES usuarios_administrativos(id) ON DELETE RESTRICT,
  CONSTRAINT area_familia_avisos_pagamento_pessoa_fk FOREIGN KEY (pessoa_id, festa_id, empresa_id)
    REFERENCES festa_pessoas (id, festa_id, empresa_id) ON DELETE RESTRICT,
  CONSTRAINT area_familia_avisos_pagamento_tratamento_check CHECK (
    (estado = 'PENDENTE' AND tratado_em IS NULL AND tratado_por_usuario_id IS NULL)
    OR (estado <> 'PENDENTE' AND tratado_em IS NOT NULL AND tratado_por_usuario_id IS NOT NULL))
);
-- No máximo um aviso pendente por parcela (a família não empilha avisos da mesma parcela).
CREATE UNIQUE INDEX area_familia_avisos_pagamento_pendente_uk ON area_familia_avisos_pagamento (parcela_id) WHERE estado = 'PENDENTE';
CREATE INDEX area_familia_avisos_pagamento_festa_idx ON area_familia_avisos_pagamento (festa_id, criado_em DESC);

CREATE FUNCTION kidmais_125_aviso_pagamento_validar() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE numero_real smallint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '125: aviso de pagamento não é apagado' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.festa_id IS DISTINCT FROM OLD.festa_id OR NEW.empresa_id IS DISTINCT FROM OLD.empresa_id
       OR NEW.pessoa_id IS DISTINCT FROM OLD.pessoa_id OR NEW.parcela_id IS DISTINCT FROM OLD.parcela_id
       OR NEW.parcela_numero IS DISTINCT FROM OLD.parcela_numero OR NEW.saldo_centavos IS DISTINCT FROM OLD.saldo_centavos
       OR NEW.observacao IS DISTINCT FROM OLD.observacao OR NEW.criado_em IS DISTINCT FROM OLD.criado_em THEN
      RAISE EXCEPTION '125: aviso de pagamento: só o tratamento muda' USING ERRCODE = '23514';
    END IF;
    IF OLD.estado <> 'PENDENTE' THEN
      RAISE EXCEPTION '125: aviso de pagamento já tratado' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.estado <> 'PENDENTE' THEN
    RAISE EXCEPTION '125: aviso de pagamento nasce pendente' USING ERRCODE = '23514';
  END IF;
  IF NEW.empresa_id IS DISTINCT FROM kidmais_123_empresa_da_festa(NEW.festa_id) THEN
    RAISE EXCEPTION '125: empresa do aviso difere da empresa da festa' USING ERRCODE = '23514';
  END IF;
  IF NOT kidmais_125_pessoa_ativa(NEW.pessoa_id, NEW.festa_id) THEN
    RAISE EXCEPTION '125: só pessoa ativa da festa avisa pagamento' USING ERRCODE = '23514';
  END IF;
  -- A parcela é de um pagamento de uma versão do contrato DESTA festa.
  SELECT pp.numero INTO numero_real FROM pagamento_parcelas pp
    JOIN pagamento_planos pl ON pl.id = pp.plano_id
    JOIN pagamentos pg ON pg.id = pl.pagamento_id
    JOIN contrato_versoes cv ON cv.id = pg.contrato_versao_id
    JOIN festas f ON f.contrato_id = cv.contrato_id
   WHERE pp.id = NEW.parcela_id AND f.id = NEW.festa_id;
  IF numero_real IS NULL THEN
    RAISE EXCEPTION '125: parcela fora do contrato da festa' USING ERRCODE = '23514';
  END IF;
  IF numero_real <> NEW.parcela_numero THEN
    RAISE EXCEPTION '125: número da parcela não confere' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER area_familia_avisos_pagamento_validar_trg BEFORE INSERT OR UPDATE OR DELETE ON area_familia_avisos_pagamento
  FOR EACH ROW EXECUTE FUNCTION kidmais_125_aviso_pagamento_validar();

-- -----------------------------------------------------------------------------
-- 2. Pendência mostrada à família
-- -----------------------------------------------------------------------------
CREATE TABLE festa_pendencias_familia (
  pendencia_id uuid PRIMARY KEY,
  festa_id uuid NOT NULL,
  empresa_id uuid NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  visivel boolean NOT NULL,
  texto text NOT NULL CHECK (length(btrim(texto)) BETWEEN 1 AND 280 AND texto = btrim(texto)),
  atualizado_por_usuario_id uuid NOT NULL REFERENCES usuarios_administrativos(id) ON DELETE RESTRICT,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  feito_em timestamptz,
  feito_por_pessoa_id uuid,
  devolvido_em timestamptz,
  devolvido_por_usuario_id uuid REFERENCES usuarios_administrativos(id) ON DELETE RESTRICT,
  CONSTRAINT festa_pendencias_familia_pendencia_fk FOREIGN KEY (festa_id, pendencia_id)
    REFERENCES festa_pendencias (festa_id, id) ON DELETE RESTRICT,
  CONSTRAINT festa_pendencias_familia_pessoa_fk FOREIGN KEY (feito_por_pessoa_id, festa_id, empresa_id)
    REFERENCES festa_pessoas (id, festa_id, empresa_id) ON DELETE RESTRICT,
  CONSTRAINT festa_pendencias_familia_feito_check CHECK ((feito_em IS NULL) = (feito_por_pessoa_id IS NULL)),
  CONSTRAINT festa_pendencias_familia_devolvido_check CHECK ((devolvido_em IS NULL) = (devolvido_por_usuario_id IS NULL)),
  -- Marcada feita e devolvida ao mesmo tempo não existe: a devolução limpa o "feito", um "feito" novo limpa a devolução.
  CONSTRAINT festa_pendencias_familia_feito_devolvido_check CHECK (feito_em IS NULL OR devolvido_em IS NULL)
);
CREATE INDEX festa_pendencias_familia_festa_idx ON festa_pendencias_familia (festa_id);
CREATE TRIGGER festa_pendencias_familia_atualizado_em_trg BEFORE UPDATE ON festa_pendencias_familia
  FOR EACH ROW EXECUTE FUNCTION kidmais_set_atualizado_em();

CREATE FUNCTION kidmais_125_pendencia_familia_validar() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE natureza_real text; estado_real text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '125: pendência da família não é apagada (use visível = não)' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.pendencia_id IS DISTINCT FROM OLD.pendencia_id OR NEW.festa_id IS DISTINCT FROM OLD.festa_id
       OR NEW.empresa_id IS DISTINCT FROM OLD.empresa_id OR NEW.criado_em IS DISTINCT FROM OLD.criado_em) THEN
    RAISE EXCEPTION '125: pendência, festa e empresa são imutáveis' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.empresa_id IS DISTINCT FROM kidmais_123_empresa_da_festa(NEW.festa_id) THEN
      RAISE EXCEPTION '125: empresa da pendência difere da empresa da festa' USING ERRCODE = '23514';
    END IF;
    IF NEW.feito_em IS NOT NULL OR NEW.devolvido_em IS NOT NULL THEN
      RAISE EXCEPTION '125: pendência da família nasce sem feito nem devolução' USING ERRCODE = '23514';
    END IF;
  END IF;
  SELECT natureza, estado INTO natureza_real, estado_real FROM festa_pendencias WHERE id = NEW.pendencia_id AND festa_id = NEW.festa_id;
  IF natureza_real IS DISTINCT FROM 'CLIENTE' THEN
    RAISE EXCEPTION '125: só pendência do cliente vai para a família' USING ERRCODE = '23514';
  END IF;
  -- Marcar feito (de não feito para feito): pessoa ativa da festa, pendência visível e ainda aberta.
  IF NEW.feito_em IS NOT NULL AND (TG_OP = 'INSERT' OR OLD.feito_em IS NULL OR NEW.feito_por_pessoa_id IS DISTINCT FROM OLD.feito_por_pessoa_id
       OR NEW.feito_em IS DISTINCT FROM OLD.feito_em) THEN
    IF TG_OP = 'UPDATE' AND OLD.feito_em IS NOT NULL THEN
      RAISE EXCEPTION '125: pendência já marcada feita' USING ERRCODE = '23514';
    END IF;
    IF NOT kidmais_125_pessoa_ativa(NEW.feito_por_pessoa_id, NEW.festa_id) THEN
      RAISE EXCEPTION '125: só pessoa ativa da festa marca feito' USING ERRCODE = '23514';
    END IF;
    IF NOT NEW.visivel OR estado_real NOT IN ('ABERTA', 'EM_TRATAMENTO') THEN
      RAISE EXCEPTION '125: pendência oculta ou encerrada não é marcada feita' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER festa_pendencias_familia_validar_trg BEFORE INSERT OR UPDATE OR DELETE ON festa_pendencias_familia
  FOR EACH ROW EXECUTE FUNCTION kidmais_125_pendencia_familia_validar();

-- -----------------------------------------------------------------------------
-- 3. Aviso fixo por buffet
-- -----------------------------------------------------------------------------
CREATE TABLE area_familia_aviso_empresa (
  empresa_id uuid PRIMARY KEY REFERENCES empresas(id) ON DELETE RESTRICT,
  texto text CHECK (texto IS NULL OR (length(btrim(texto)) BETWEEN 1 AND 500 AND texto = btrim(texto))),
  atualizado_por_usuario_id uuid NOT NULL REFERENCES usuarios_administrativos(id) ON DELETE RESTRICT,
  atualizado_em timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER area_familia_aviso_empresa_atualizado_em_trg BEFORE UPDATE ON area_familia_aviso_empresa
  FOR EACH ROW EXECUTE FUNCTION kidmais_set_atualizado_em();

-- -----------------------------------------------------------------------------
-- 4. Eventos: tipos da 125 e autoria conferida
-- -----------------------------------------------------------------------------
ALTER TABLE area_familia_eventos DROP CONSTRAINT area_familia_eventos_tipo_check;
ALTER TABLE area_familia_eventos ADD CONSTRAINT area_familia_eventos_tipo_check CHECK (tipo IN (
  'LINK_GERADO', 'LINK_REVOGADO', 'ENTRADA', 'SAIR', 'SAIR_DE_TODOS', 'BUFFET_DESCONECTOU',
  'PESSOA_CADASTRADA', 'PESSOA_REMOVIDA', 'CONTATO_ALTERADO', 'SESSOES_DERRUBADAS',
  'AVISO_PAGAMENTO', 'AVISO_PAGAMENTO_TRATADO', 'PENDENCIA_FEITA', 'PENDENCIA_DEVOLVIDA', 'PENDENCIA_VISIBILIDADE', 'AVISO_FIXO'));

-- A pessoa citada e a pessoa autora de um evento são da festa do evento (a 123 só exigia que existissem).
CREATE FUNCTION kidmais_125_evento_pessoas_da_festa() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.pessoa_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM festa_pessoas WHERE id = NEW.pessoa_id AND festa_id = NEW.festa_id) THEN
    RAISE EXCEPTION '125: pessoa do evento é de outra festa' USING ERRCODE = '23514';
  END IF;
  IF NEW.autor_pessoa_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM festa_pessoas WHERE id = NEW.autor_pessoa_id AND festa_id = NEW.festa_id) THEN
    RAISE EXCEPTION '125: autor do evento é de outra festa' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER area_familia_eventos_125_pessoas_trg BEFORE INSERT ON area_familia_eventos
  FOR EACH ROW EXECUTE FUNCTION kidmais_125_evento_pessoas_da_festa();

-- -----------------------------------------------------------------------------
-- 5. Autoria pela família (pessoas e links)
-- -----------------------------------------------------------------------------
-- Remoção feita por pessoa: só o contratante ativo da mesma festa, e só do segundo responsável. Depois de registrada,
-- a autoria da remoção não muda (a 123 já impede o removido_em de voltar, mas não o autor).
CREATE FUNCTION kidmais_125_remocao_por_pessoa() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.removido_em IS NOT NULL AND (NEW.removido_por_pessoa_id IS DISTINCT FROM OLD.removido_por_pessoa_id
     OR NEW.removido_por_usuario_id IS DISTINCT FROM OLD.removido_por_usuario_id) THEN
    RAISE EXCEPTION '125: autoria da remoção registrada não muda' USING ERRCODE = '23514';
  END IF;
  IF NEW.removido_por_pessoa_id IS NOT NULL AND OLD.removido_por_pessoa_id IS NULL THEN
    IF NEW.papel <> 'SEGUNDO_RESPONSAVEL' OR NEW.removido_por_pessoa_id = NEW.id
       OR NOT kidmais_125_contratante_ativo(NEW.removido_por_pessoa_id, NEW.festa_id) THEN
      RAISE EXCEPTION '125: só o contratante da mesma festa remove o segundo responsável' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER festa_pessoas_125_remocao_trg BEFORE UPDATE OF removido_por_pessoa_id, removido_por_usuario_id ON festa_pessoas
  FOR EACH ROW EXECUTE FUNCTION kidmais_125_remocao_por_pessoa();

-- Link gerado por pessoa: só o contratante ativo da mesma festa, e só para o segundo responsável ativo dela.
CREATE FUNCTION kidmais_125_link_por_pessoa() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.criado_por_pessoa_id IS NOT NULL THEN
    IF NOT kidmais_125_contratante_ativo(NEW.criado_por_pessoa_id, NEW.festa_id)
       OR NOT EXISTS (SELECT 1 FROM festa_pessoas WHERE id = NEW.pessoa_id AND festa_id = NEW.festa_id
                       AND papel = 'SEGUNDO_RESPONSAVEL' AND removido_em IS NULL) THEN
      RAISE EXCEPTION '125: só o contratante da mesma festa gera link, e só para o segundo responsável' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER festa_links_area_125_autoria_trg BEFORE INSERT ON festa_links_area
  FOR EACH ROW EXECUTE FUNCTION kidmais_125_link_por_pessoa();

COMMENT ON TABLE area_familia_avisos_pagamento IS '125: "Já paguei" da área Minha festa; a equipe confere ou descarta; não dá baixa.';
COMMENT ON TABLE festa_pendencias_familia IS '125: o que a família vê de uma pendência CLIENTE (texto próprio, feito, devolvido).';
COMMENT ON TABLE area_familia_aviso_empresa IS '125: aviso fixo do buffet na área Minha festa.';

COMMIT;
