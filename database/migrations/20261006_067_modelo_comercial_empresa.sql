-- 067 — Modelo comercial da empresa (venda por assinatura, E3): assinatura/teste, exceções comerciais e representação.
--
-- NÃO APLICADA. Exige autorização explícita (docs/OPERACAO_AGENTES.md) para qualquer banco, inclusive staging e clones.
--
-- Eixos separados (docs/PROPOSTA_VENDA_ASSINATURA_20261006.md §4.5), nenhum derivado do navegador:
--   - empresas.status (ATIVA/SUSPENSA/DESATIVADA) continua sendo decisão ADMINISTRATIVA da plataforma; nada aqui o muda;
--   - empresa_assinaturas: situação comercial. Empresa SEM linha = sem cobrança (Kidmais e todas as empresas atuais):
--     acesso completo como hoje. Só o cadastro público (E6) cria a linha, já em TESTE;
--   - empresa_excecoes_comerciais: extensão de teste, cortesia e acesso temporário, sempre com prazo e motivo;
--   - empresa_representacoes: declaração de representação legal (sócio, procurador, responsável indicado) e a decisão
--     da plataforma. Aprovar representação NUNCA concede acesso: permissões continuam em memberships.
-- O acesso comercial (COMPLETO / SOMENTE_LEITURA / BLOQUEADO) é calculado pelo código a partir das datas gravadas
-- (lib/assinatura/acesso.ts); nenhuma tarefa agendada é necessária para o teste vencer.
-- Nenhuma tabela existente é alterada.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = public, pg_catalog;

DO $$ BEGIN
  IF to_regclass('public.empresa_assinaturas') IS NOT NULL THEN RAISE EXCEPTION '067 já aplicada.'; END IF;
  IF to_regclass('public.empresas') IS NULL THEN RAISE EXCEPTION '067 exige a 031 (empresas).'; END IF;
  IF to_regclass('public.usuarios_administrativos') IS NULL THEN RAISE EXCEPTION '067 exige a 013 (usuarios_administrativos).'; END IF;
END $$;

CREATE TABLE empresa_assinaturas (
  empresa_id uuid PRIMARY KEY REFERENCES empresas (id),
  plano text NOT NULL DEFAULT 'UNICO',
  ciclo text,
  situacao text NOT NULL,
  teste_inicio timestamptz NOT NULL,
  teste_fim timestamptz NOT NULL,
  periodo_atual_fim timestamptz,
  em_atraso_desde timestamptz,
  cancelada_em timestamptz,
  encerrada_em timestamptz,
  provedor text,
  provedor_cliente_id text,
  provedor_assinatura_id text,
  versao integer NOT NULL DEFAULT 1,
  criado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  atualizado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT empresa_assinaturas_plano_check CHECK (plano IN ('UNICO')),
  CONSTRAINT empresa_assinaturas_ciclo_check CHECK (ciclo IS NULL OR ciclo IN ('MENSAL', 'ANUAL')),
  CONSTRAINT empresa_assinaturas_situacao_check CHECK (situacao IN ('TESTE', 'ATIVA', 'EM_ATRASO', 'CANCELADA_FIM_PERIODO', 'ENCERRADA')),
  CONSTRAINT empresa_assinaturas_teste_check CHECK (teste_fim > teste_inicio),
  -- Pagante tem ciclo e fim do período pago; teste não tem ciclo nem provedor obrigatório.
  CONSTRAINT empresa_assinaturas_pagante_check CHECK (situacao = 'TESTE' OR situacao = 'ENCERRADA' OR (ciclo IS NOT NULL AND periodo_atual_fim IS NOT NULL)),
  CONSTRAINT empresa_assinaturas_atraso_check CHECK ((situacao = 'EM_ATRASO') = (em_atraso_desde IS NOT NULL)),
  CONSTRAINT empresa_assinaturas_cancelada_check CHECK (situacao <> 'CANCELADA_FIM_PERIODO' OR cancelada_em IS NOT NULL),
  CONSTRAINT empresa_assinaturas_encerrada_check CHECK ((situacao = 'ENCERRADA') = (encerrada_em IS NOT NULL)),
  CONSTRAINT empresa_assinaturas_provedor_check CHECK (provedor IS NULL OR provedor IN ('ASAAS')),
  CONSTRAINT empresa_assinaturas_provedor_ids_check CHECK (provedor IS NOT NULL OR (provedor_cliente_id IS NULL AND provedor_assinatura_id IS NULL)),
  CONSTRAINT empresa_assinaturas_versao_check CHECK (versao > 0)
);
CREATE UNIQUE INDEX empresa_assinaturas_provedor_assinatura_uk ON empresa_assinaturas (provedor, provedor_assinatura_id) WHERE provedor_assinatura_id IS NOT NULL;
CREATE UNIQUE INDEX empresa_assinaturas_provedor_cliente_uk ON empresa_assinaturas (provedor, provedor_cliente_id) WHERE provedor_cliente_id IS NOT NULL;

-- Exceções comerciais: sempre com prazo, motivo e autor; revogação registrada; nunca apagadas.
CREATE TABLE empresa_excecoes_comerciais (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresas (id),
  tipo text NOT NULL,
  valida_ate timestamptz NOT NULL,
  motivo text NOT NULL,
  criado_por uuid NOT NULL REFERENCES usuarios_administrativos (id),
  criado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  revogada_em timestamptz,
  revogada_por uuid REFERENCES usuarios_administrativos (id),
  motivo_revogacao text,
  CONSTRAINT empresa_excecoes_tipo_check CHECK (tipo IN ('EXTENSAO_TESTE', 'CORTESIA', 'ACESSO_TEMPORARIO')),
  CONSTRAINT empresa_excecoes_motivo_check CHECK (char_length(btrim(motivo)) BETWEEN 5 AND 500),
  CONSTRAINT empresa_excecoes_prazo_check CHECK (valida_ate > criado_em AND valida_ate <= criado_em + interval '366 days'),
  CONSTRAINT empresa_excecoes_revogacao_check CHECK ((revogada_em IS NULL) = (revogada_por IS NULL) AND (revogada_em IS NULL OR char_length(btrim(coalesce(motivo_revogacao, ''))) BETWEEN 5 AND 500))
);
CREATE INDEX empresa_excecoes_empresa_idx ON empresa_excecoes_comerciais (empresa_id, valida_ate DESC);

CREATE FUNCTION kidmais_067_excecao_guarda() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Exceção comercial não é apagada; revogue.' USING ERRCODE = 'P0001'; END IF;
  IF NEW.id <> OLD.id OR NEW.empresa_id <> OLD.empresa_id OR NEW.tipo <> OLD.tipo OR NEW.valida_ate <> OLD.valida_ate
     OR NEW.motivo <> OLD.motivo OR NEW.criado_por <> OLD.criado_por OR NEW.criado_em <> OLD.criado_em THEN
    RAISE EXCEPTION 'Exceção comercial é imutável; só a revogação é registrada.' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.revogada_em IS NOT NULL THEN RAISE EXCEPTION 'Exceção já revogada.' USING ERRCODE = 'P0001'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER empresa_excecoes_067_guarda_trg BEFORE UPDATE OR DELETE ON empresa_excecoes_comerciais
  FOR EACH ROW EXECUTE FUNCTION kidmais_067_excecao_guarda();

-- Representação legal declarada por uma pessoa para uma empresa (pode ser diferente do sócio do cadastro oficial).
CREATE TABLE empresa_representacoes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresas (id),
  usuario_id uuid NOT NULL REFERENCES usuarios_administrativos (id),
  qualificacao text NOT NULL,
  descricao_evidencia text,
  situacao text NOT NULL DEFAULT 'DECLARADA',
  declarado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  decidido_por uuid REFERENCES usuarios_administrativos (id),
  decidido_em timestamptz,
  motivo_decisao text,
  CONSTRAINT empresa_representacoes_qualificacao_check CHECK (qualificacao IN ('SOCIO_ADMINISTRADOR', 'PROCURADOR', 'RESPONSAVEL_INDICADO')),
  CONSTRAINT empresa_representacoes_situacao_check CHECK (situacao IN ('DECLARADA', 'APROVADA', 'RECUSADA', 'REVOGADA')),
  CONSTRAINT empresa_representacoes_evidencia_check CHECK (descricao_evidencia IS NULL OR char_length(descricao_evidencia) <= 1000),
  CONSTRAINT empresa_representacoes_decisao_check CHECK (
    (situacao = 'DECLARADA' AND decidido_por IS NULL AND decidido_em IS NULL)
    OR (situacao <> 'DECLARADA' AND decidido_por IS NOT NULL AND decidido_em IS NOT NULL AND char_length(btrim(coalesce(motivo_decisao, ''))) BETWEEN 5 AND 500)
  )
);
-- No máximo uma representação em aberto ou aprovada por pessoa e empresa.
CREATE UNIQUE INDEX empresa_representacoes_vigente_uk ON empresa_representacoes (empresa_id, usuario_id) WHERE situacao IN ('DECLARADA', 'APROVADA');

CREATE FUNCTION kidmais_067_representacao_guarda() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Representação não é apagada.' USING ERRCODE = 'P0001'; END IF;
  IF NEW.id <> OLD.id OR NEW.empresa_id <> OLD.empresa_id OR NEW.usuario_id <> OLD.usuario_id OR NEW.qualificacao <> OLD.qualificacao
     OR NEW.declarado_em <> OLD.declarado_em THEN
    RAISE EXCEPTION 'Identidade da representação é imutável.' USING ERRCODE = 'P0001';
  END IF;
  -- DECLARADA → APROVADA | RECUSADA; APROVADA → REVOGADA. RECUSADA e REVOGADA são terminais (nova declaração = nova linha).
  IF NOT ((OLD.situacao = 'DECLARADA' AND NEW.situacao IN ('APROVADA', 'RECUSADA')) OR (OLD.situacao = 'APROVADA' AND NEW.situacao = 'REVOGADA')) THEN
    RAISE EXCEPTION 'Transição de representação inválida: % → %.', OLD.situacao, NEW.situacao USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER empresa_representacoes_067_guarda_trg BEFORE UPDATE OR DELETE ON empresa_representacoes
  FOR EACH ROW EXECUTE FUNCTION kidmais_067_representacao_guarda();

COMMENT ON TABLE empresa_assinaturas IS '067: situação comercial. Empresa sem linha = sem cobrança (acesso completo).';
COMMENT ON TABLE empresa_excecoes_comerciais IS '067: exceções comerciais com prazo, motivo e revogação registrada.';
COMMENT ON TABLE empresa_representacoes IS '067: representação legal declarada e decidida pela plataforma; não concede acesso.';

COMMIT;
