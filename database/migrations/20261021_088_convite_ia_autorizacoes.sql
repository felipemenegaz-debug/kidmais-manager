-- 088: autorização específica do responsável legal para Convites com IA (parecer da Astra de 21/10/2026, ponto
-- urgente 1; decisão de Felipe de manter o recurso ligado). Executar somente após autorização própria do ambiente,
-- precheck e backup operacional. Aditiva: cria uma tabela nova e não altera linha nem coluna existente.
-- ORDEM: aplicar ANTES do deploy do código que a lê. Depois do deploy, toda geração exige uma autorização registrada
-- aqui (as festas existentes passam a pedir a autorização antes da próxima geração; nada é preenchido por backfill).
-- Isolamento por empresa no padrão do repositório (sem RLS/GRANT próprios em nenhuma migration): chave composta
-- (convite_id, empresa_id) → convites, gatilho que confere festa/empresa/operador e serviço sempre filtrando pela
-- empresa comprovada da sessão.
-- Registro: quem operou, declaração, identificação mínima do responsável (nome e vínculo; nunca documento), meio,
-- criança/evento (festa e convite), finalidade, provedor, versão e hash do texto exibido, data/hora e foto sim/não.
-- Revogação para usos futuros: só as colunas de revogação podem mudar, uma única vez. DELETE não é bloqueado: a
-- eliminação segue a política de retenção decidida (ver docs/CONVITES_IA_CONSENTIMENTO_20261021.md).
-- Rollback: database/rollback/20261021_088_convite_ia_autorizacoes_down.sql (recusado se houver autorizações).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;
DO $$
BEGIN
  IF to_regclass('public.convites') IS NULL OR to_regclass('public.memberships') IS NULL OR to_regclass('public.usuarios_administrativos') IS NULL
    OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.convites'::regclass AND contype='u'
      AND conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='public.convites'::regclass AND attname='id'),
                         (SELECT attnum FROM pg_attribute WHERE attrelid='public.convites'::regclass AND attname='empresa_id')]::int2[])
    OR to_regclass('public.convite_ia_autorizacoes') IS NOT NULL
    OR to_regprocedure('public.convite_ia_autorizacao_validar()') IS NOT NULL THEN
    RAISE EXCEPTION '088: precheck falhou (073 ausente ou 088 anterior/parcial); nada alterado';
  END IF;
END $$;
CREATE TABLE convite_ia_autorizacoes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresas(id),
  convite_id uuid NOT NULL,
  festa_id uuid NOT NULL REFERENCES festas(id),
  finalidade text NOT NULL DEFAULT 'CONVITE_IA' CHECK (finalidade = 'CONVITE_IA'),
  provedor text NOT NULL CHECK (provedor IN ('openai','gemini')),
  texto_versao text NOT NULL CHECK (texto_versao ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  texto_hash text NOT NULL CHECK (texto_hash ~ '^[0-9a-f]{64}$'),
  operador_tipo text NOT NULL CHECK (operador_tipo IN ('BUFFET','CLIENTE')),
  operador_usuario_id uuid REFERENCES usuarios_administrativos(id),
  operador_cliente_id uuid REFERENCES clientes(id),
  responsavel_nome varchar(120) NOT NULL CHECK (length(btrim(responsavel_nome)) BETWEEN 2 AND 120),
  responsavel_vinculo text NOT NULL CHECK (responsavel_vinculo IN ('MAE','PAI','TUTOR','OUTRO_RESPONSAVEL_LEGAL')),
  meio text NOT NULL CHECK (meio IN ('PROPRIO_RESPONSAVEL','PRESENCIAL','WHATSAPP','EMAIL','TELEFONE','OUTRO')),
  declaracao_responsavel boolean NOT NULL CHECK (declaracao_responsavel),
  foto_autorizada boolean NOT NULL,
  criado_em timestamptz NOT NULL DEFAULT now(),
  revogada_em timestamptz,
  revogada_por text CHECK (revogada_por IS NULL OR revogada_por ~ '^(USUARIO|CLIENTE|OPERADOR|SISTEMA):[A-Za-z0-9_-]{1,64}$'),
  revogacao_motivo text CHECK (revogacao_motivo IN ('REVOGADA','SUBSTITUIDA')),
  FOREIGN KEY (convite_id, empresa_id) REFERENCES convites(id, empresa_id),
  -- Quem opera: funcionário do buffet registra a autorização recebida (por um meio); o responsável no link autoriza por si.
  CONSTRAINT convite_ia_autorizacoes_operador CHECK (
    (operador_tipo = 'BUFFET' AND operador_usuario_id IS NOT NULL AND operador_cliente_id IS NULL AND meio <> 'PROPRIO_RESPONSAVEL')
    OR (operador_tipo = 'CLIENTE' AND operador_cliente_id IS NOT NULL AND operador_usuario_id IS NULL AND meio = 'PROPRIO_RESPONSAVEL')),
  CONSTRAINT convite_ia_autorizacoes_revogacao CHECK (
    (revogada_em IS NULL) = (revogada_por IS NULL) AND (revogada_em IS NULL) = (revogacao_motivo IS NULL)
    AND (revogada_em IS NULL OR revogada_em >= criado_em))
);
-- No máximo uma autorização não revogada por convite (festa/criança); registrar outra encerra a anterior (SUBSTITUIDA).
CREATE UNIQUE INDEX convite_ia_autorizacao_vigente ON convite_ia_autorizacoes(convite_id) WHERE revogada_em IS NULL;
CREATE INDEX convite_ia_autorizacoes_empresa ON convite_ia_autorizacoes(empresa_id, convite_id, criado_em DESC);
-- Comprovação relacional (como a 073): nem inserts manuais vinculam festa, cliente ou usuário de outra empresa.
CREATE FUNCTION convite_ia_autorizacao_validar() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.revogada_em IS NOT NULL THEN RAISE EXCEPTION 'Autorização de IA: registro novo não pode nascer revogado'; END IF;
    IF NOT EXISTS (SELECT 1 FROM convites c WHERE c.id = NEW.convite_id AND c.empresa_id = NEW.empresa_id AND c.festa_id = NEW.festa_id) THEN
      RAISE EXCEPTION 'Autorização de IA: convite, festa e empresa não correspondem';
    END IF;
    IF NEW.operador_cliente_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM convites c WHERE c.id = NEW.convite_id AND c.cliente_id = NEW.operador_cliente_id) THEN
      RAISE EXCEPTION 'Autorização de IA: cliente não é o do convite';
    END IF;
    IF NEW.operador_usuario_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.empresa_id = NEW.empresa_id
        AND m.usuario_id = NEW.operador_usuario_id AND m.status = 'ATIVA') THEN
      RAISE EXCEPTION 'Autorização de IA: usuário sem vínculo ativo com a empresa';
    END IF;
    RETURN NEW;
  END IF;
  -- UPDATE: somente a revogação, uma vez; todo o resto é evidência imutável.
  IF OLD.revogada_em IS NOT NULL OR NEW.revogada_em IS NULL
    OR (NEW.id, NEW.empresa_id, NEW.convite_id, NEW.festa_id, NEW.finalidade, NEW.provedor, NEW.texto_versao, NEW.texto_hash, NEW.operador_tipo,
        NEW.operador_usuario_id, NEW.operador_cliente_id, NEW.responsavel_nome, NEW.responsavel_vinculo, NEW.meio, NEW.declaracao_responsavel,
        NEW.foto_autorizada, NEW.criado_em)
      IS DISTINCT FROM
       (OLD.id, OLD.empresa_id, OLD.convite_id, OLD.festa_id, OLD.finalidade, OLD.provedor, OLD.texto_versao, OLD.texto_hash, OLD.operador_tipo,
        OLD.operador_usuario_id, OLD.operador_cliente_id, OLD.responsavel_nome, OLD.responsavel_vinculo, OLD.meio, OLD.declaracao_responsavel,
        OLD.foto_autorizada, OLD.criado_em) THEN
    RAISE EXCEPTION 'Autorização de IA: registro imutável; só a revogação pode ser gravada, uma vez';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER convite_ia_autorizacao_validar BEFORE INSERT OR UPDATE ON convite_ia_autorizacoes
  FOR EACH ROW EXECUTE FUNCTION convite_ia_autorizacao_validar();
COMMENT ON TABLE convite_ia_autorizacoes IS 'Autorização específica do responsável legal para gerar convite com IA (088). Sem cópia de documento.';
COMMIT;
