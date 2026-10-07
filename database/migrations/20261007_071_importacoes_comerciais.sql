-- 071 — Importações comerciais por PDF: a empresa envia a tabela de preços (e, depois, o modelo de contrato) em PDF;
-- o sistema lê com IA, a equipe revisa e só então publica pelos serviços de domínio.
--
-- NÃO APLICADA. Exige 031 (empresas no comercial) e 070, e autorização explícita (docs/OPERACAO_AGENTES.md).
--
--   1. importacoes_comerciais: uma importação por envio. Guarda o PDF original (bytea, até 15 MB), a leitura bruta do
--      modelo (jsonb), a revisão editada pela equipe (jsonb, com versão para edição concorrente) e o resultado da
--      publicação. Situação RASCUNHO → PUBLICADA | DESCARTADA; publicada/descartada não volta.
--   2. Tudo por empresa (empresa_id obrigatório); nada aqui altera preço, pacote ou contrato: a publicação passa pelos
--      serviços comerciais, com auditoria própria.
-- Nenhuma linha existente é criada ou alterada.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = public, pg_catalog;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'adicionais' AND column_name = 'origem_buffet_item_id') THEN
    RAISE EXCEPTION '071 exige a 070.';
  END IF;
  IF to_regclass('public.importacoes_comerciais') IS NOT NULL THEN RAISE EXCEPTION '071 já aplicada.'; END IF;
END $$;

CREATE TABLE importacoes_comerciais (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  tipo text NOT NULL,
  situacao text NOT NULL DEFAULT 'RASCUNHO',
  arquivo_nome text NOT NULL,
  arquivo_sha256 char(64) NOT NULL,
  arquivo_bytes bytea NOT NULL,
  leitura jsonb,
  revisao jsonb,
  versao integer NOT NULL DEFAULT 1,
  metodo text,
  provedor text,
  modelo text,
  avisos jsonb NOT NULL DEFAULT '[]'::jsonb,
  resultado jsonb,
  criado_por uuid,
  publicado_por uuid,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  publicado_em timestamptz,
  descartado_em timestamptz,
  CONSTRAINT importacoes_comerciais_tipo_check CHECK (tipo IN ('TABELA_PRECOS', 'MODELO_CONTRATO')),
  CONSTRAINT importacoes_comerciais_situacao_check CHECK (situacao IN ('RASCUNHO', 'PUBLICADA', 'DESCARTADA')),
  CONSTRAINT importacoes_comerciais_nome_check CHECK (char_length(btrim(arquivo_nome)) BETWEEN 1 AND 200),
  CONSTRAINT importacoes_comerciais_sha_check CHECK (arquivo_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT importacoes_comerciais_tamanho_check CHECK (octet_length(arquivo_bytes) BETWEEN 1 AND 15728640),
  CONSTRAINT importacoes_comerciais_versao_check CHECK (versao >= 1),
  CONSTRAINT importacoes_comerciais_desfecho_check CHECK (
    (situacao = 'RASCUNHO' AND publicado_em IS NULL AND descartado_em IS NULL)
    OR (situacao = 'PUBLICADA' AND publicado_em IS NOT NULL AND descartado_em IS NULL)
    OR (situacao = 'DESCARTADA' AND descartado_em IS NOT NULL AND publicado_em IS NULL))
);
CREATE INDEX importacoes_comerciais_empresa_idx ON importacoes_comerciais (empresa_id, tipo, criado_em DESC);

CREATE FUNCTION kidmais_071_guarda_importacao() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF OLD.situacao <> 'RASCUNHO' THEN
    RAISE EXCEPTION '071: importação % já encerrada (%).', OLD.id, OLD.situacao USING ERRCODE = 'P0001';
  END IF;
  IF NEW.empresa_id <> OLD.empresa_id OR NEW.tipo <> OLD.tipo OR NEW.arquivo_sha256 <> OLD.arquivo_sha256
     OR NEW.arquivo_bytes IS DISTINCT FROM OLD.arquivo_bytes OR NEW.criado_em <> OLD.criado_em THEN
    RAISE EXCEPTION '071: empresa, tipo, arquivo e criação da importação são imutáveis.' USING ERRCODE = 'P0001';
  END IF;
  NEW.atualizado_em := clock_timestamp();
  RETURN NEW;
END $$;

CREATE TRIGGER importacoes_comerciais_071_guarda_trg
  BEFORE UPDATE ON importacoes_comerciais
  FOR EACH ROW EXECUTE FUNCTION kidmais_071_guarda_importacao();

COMMENT ON TABLE importacoes_comerciais IS '071: PDF comercial (tabela de preços, modelo de contrato) lido por IA e revisado antes de publicar.';

COMMIT;
