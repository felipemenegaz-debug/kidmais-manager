-- 072 — Modelo de contrato por empresa: cada empresa publica o SEU texto contratual (lido do PDF da loja e revisado),
-- e os contratos dela passam a ser gerados nesse padrão, com os campos preenchidos pelo snapshot da versão.
--
-- NÃO APLICADA. Exige 071 e autorização explícita (docs/OPERACAO_AGENTES.md).
--
--   1. modelos_contrato_empresa: versões numeradas por empresa; no máximo uma ATIVA. Conteúdo (jsonb) e hash são
--      imutáveis: mudar o texto é publicar outra versão. A anterior fica SUBSTITUIDA e continua legível, porque os
--      contratos já gerados guardam o próprio PDF (contrato_documentos) e nunca são regerados por outra versão.
--   2. Publicar exige aprovação humana registrada (quem e quando).
-- Nenhuma linha existente é criada ou alterada. Sem modelo ativo, a empresa continua como antes.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = public, pg_catalog;

DO $$ BEGIN
  IF to_regclass('public.importacoes_comerciais') IS NULL THEN RAISE EXCEPTION '072 exige a 071.'; END IF;
  IF to_regclass('public.modelos_contrato_empresa') IS NOT NULL THEN RAISE EXCEPTION '072 já aplicada.'; END IF;
END $$;

CREATE TABLE modelos_contrato_empresa (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  versao integer NOT NULL,
  situacao text NOT NULL DEFAULT 'ATIVO',
  conteudo jsonb NOT NULL,
  conteudo_sha256 char(64) NOT NULL,
  importacao_id uuid REFERENCES importacoes_comerciais(id) ON DELETE RESTRICT,
  aprovado_por uuid NOT NULL,
  aprovado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  substituido_em timestamptz,
  CONSTRAINT modelos_contrato_empresa_versao_check CHECK (versao >= 1),
  CONSTRAINT modelos_contrato_empresa_situacao_check CHECK (situacao IN ('ATIVO', 'SUBSTITUIDO')),
  CONSTRAINT modelos_contrato_empresa_sha_check CHECK (conteudo_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT modelos_contrato_empresa_substituicao_check CHECK ((situacao = 'ATIVO') = (substituido_em IS NULL)),
  CONSTRAINT modelos_contrato_empresa_versao_uk UNIQUE (empresa_id, versao)
);
CREATE UNIQUE INDEX modelos_contrato_empresa_ativo_uk ON modelos_contrato_empresa (empresa_id) WHERE situacao = 'ATIVO';

CREATE FUNCTION kidmais_072_guarda_modelo() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '072: modelo de contrato não é apagado; publique outra versão.' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.empresa_id <> OLD.empresa_id OR NEW.versao <> OLD.versao OR NEW.conteudo IS DISTINCT FROM OLD.conteudo
     OR NEW.conteudo_sha256 <> OLD.conteudo_sha256 OR NEW.importacao_id IS DISTINCT FROM OLD.importacao_id
     OR NEW.aprovado_por <> OLD.aprovado_por OR NEW.aprovado_em <> OLD.aprovado_em THEN
    RAISE EXCEPTION '072: o conteúdo de um modelo publicado é imutável.' USING ERRCODE = 'P0001';
  END IF;
  IF NOT (OLD.situacao = 'ATIVO' AND NEW.situacao = 'SUBSTITUIDO') THEN
    RAISE EXCEPTION '072: só ATIVO → SUBSTITUIDO.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER modelos_contrato_empresa_072_guarda_trg
  BEFORE UPDATE OR DELETE ON modelos_contrato_empresa
  FOR EACH ROW EXECUTE FUNCTION kidmais_072_guarda_modelo();

COMMENT ON TABLE modelos_contrato_empresa IS '072: modelo de contrato da empresa (texto aprovado com campos do snapshot); uma versão ativa.';

COMMIT;
