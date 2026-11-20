-- =============================================================================
-- Kidmais Manager / iA.Fest — Migration 128: dados do disco persistente passam para o banco
-- Arquivo: 20261120_128_dados_fora_do_disco.sql — LOCAL, PREPARADA, não aplicada em staging nem em production.
--
-- Plano: vault "Convites geracao sobrevive ao deploy 20261120", fase 2 ("Sim, fase 2" de Felipe em 20/11/2026).
-- 128 conferida livre em 20/11/2026 (nenhuma migration, PR aberta, clone irmão ou nota usa 128). Exige a 021.
--
-- Por quê: os dois webs têm disco persistente em /opt/render/project/src/data. Na Render, serviço com disco não tem
-- deploy sem queda e a carência entre SIGTERM e SIGKILL fica presa em 30 s; uma geração de convite em curso morre no
-- deploy. Para tirar o disco, o que o site lê e grava nele vai para o banco:
--   - data/disponibilidade.json (regras comerciais e descontos legados da agenda pública, um por instalação);
--   - data/documentos-publicos/<uuid>.pdf (bytes da tabela de pacotes; os metadados já estão em documentos_publicos).
--
-- O que cria:
--   - disponibilidade_config_legada: UMA linha (id = 1) com o conteúdo do antigo arquivo em jsonb, a origem
--     (DISCO = cópia do arquivo, PAINEL = gravação pela agenda) e quando mudou.
--   - documentos_publicos.conteudo (bytea, opcional): os bytes do PDF, conferidos pelo banco contra tamanho_bytes e sha256.
-- Não copia nada: o conteúdo do disco entra depois, pelo script scripts/disco-para-banco-128.cjs no Shell do web (único
-- lugar onde o disco existe). Enquanto a linha ou os bytes faltarem, o código continua lendo o disco.
--
-- Rollback: database/rollback/20261120_128_dados_fora_do_disco_down.sql (recusa sem a confirmação explícita; com o disco
-- já removido, apagar a coluna ou a tabela perde o PDF e as regras).
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;

DO $$
BEGIN
  IF to_regclass('public.documentos_publicos') IS NULL THEN
    RAISE EXCEPTION '128: exige a 021';
  END IF;
  IF to_regclass('public.disponibilidade_config_legada') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.documentos_publicos'::regclass
                  AND attname = 'conteudo' AND NOT attisdropped) THEN
    RAISE EXCEPTION '128: já presente (inteira ou parcial)';
  END IF;
END $$;

CREATE TABLE disponibilidade_config_legada (
  id smallint PRIMARY KEY DEFAULT 1,
  conteudo jsonb NOT NULL,
  origem text NOT NULL,
  atualizado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT disponibilidade_config_legada_unica CHECK (id = 1),
  -- COALESCE: chave ausente dá jsonb_typeof NULL, e um CHECK com resultado NULL passaria.
  CONSTRAINT disponibilidade_config_legada_forma CHECK (
    jsonb_typeof(conteudo) = 'object'
    AND COALESCE(jsonb_typeof(conteudo -> 'pacoteOverrides') = 'array', false)
    AND COALESCE(jsonb_typeof(conteudo -> 'descontos') = 'array', false)),
  CONSTRAINT disponibilidade_config_legada_origem CHECK (origem IN ('DISCO', 'PAINEL'))
);
COMMENT ON TABLE disponibilidade_config_legada IS
  '128: antigo data/disponibilidade.json (regras e descontos legados da agenda pública da instalação). Uma linha só.';

ALTER TABLE documentos_publicos ADD COLUMN conteudo bytea;
ALTER TABLE documentos_publicos ADD CONSTRAINT documentos_publicos_conteudo_confere CHECK (
  conteudo IS NULL OR (octet_length(conteudo) = tamanho_bytes AND encode(sha256(conteudo), 'hex') = sha256));
COMMENT ON COLUMN documentos_publicos.conteudo IS
  '128: bytes do PDF (antes só em data/documentos-publicos no disco). NULL = ainda só no disco.';

COMMIT;
