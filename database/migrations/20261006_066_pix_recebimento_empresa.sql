-- 066 — Chave Pix de recebimento da empresa (Pix copia e cola / QR estático das parcelas das festas).
--
-- NÃO APLICADA. Exige autorização explícita (docs/OPERACAO_AGENTES.md) para qualquer banco, inclusive staging e clones.
-- Número 065 reservado: o branch whatsapp/atendimento-ia-v1 já usa 20261004_065_whatsapp_nome_perfil.sql.
--
-- Uma linha por empresa (tenant): a chave Pix DA PRÓPRIA EMPRESA para onde os clientes dela pagam as parcelas.
-- O sistema só monta o BR Code estático; nenhum valor passa pela Kidmais e nada é confirmado automaticamente.
-- Chave, nome e cidade do recebedor guardados já normalizados (formato do DICT e limites do BR Code: nome 25,
-- cidade 15). Remover a configuração é permitido (DELETE): o histórico fica na auditoria, com a chave mascarada.
-- Nenhuma tabela existente é alterada.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = public, pg_catalog;

DO $$ BEGIN
  IF to_regclass('public.empresa_pix_recebimento') IS NOT NULL THEN RAISE EXCEPTION '066 já aplicada.'; END IF;
  IF to_regclass('public.empresas') IS NULL THEN RAISE EXCEPTION '066 exige a 031 (empresas).'; END IF;
  IF to_regclass('public.usuarios_administrativos') IS NULL THEN RAISE EXCEPTION '066 exige a 013 (usuarios_administrativos).'; END IF;
END $$;

CREATE TABLE empresa_pix_recebimento (
  empresa_id uuid PRIMARY KEY REFERENCES empresas (id),
  tipo_chave text NOT NULL,
  chave text NOT NULL,
  nome_recebedor text NOT NULL,
  cidade_recebedor text NOT NULL,
  versao integer NOT NULL DEFAULT 1,
  atualizado_por uuid NOT NULL REFERENCES usuarios_administrativos (id),
  atualizado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT empresa_pix_tipo_check CHECK (tipo_chave IN ('CPF', 'CNPJ', 'EMAIL', 'TELEFONE', 'ALEATORIA')),
  CONSTRAINT empresa_pix_chave_formato_check CHECK (
    (tipo_chave = 'CPF' AND chave ~ '^[0-9]{11}$')
    OR (tipo_chave = 'CNPJ' AND chave ~ '^[0-9A-Z]{12}[0-9]{2}$')
    OR (tipo_chave = 'EMAIL' AND char_length(chave) <= 77 AND chave = lower(chave) AND chave ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')
    OR (tipo_chave = 'TELEFONE' AND chave ~ '^\+55[1-9]{2}9?[0-9]{8}$')
    OR (tipo_chave = 'ALEATORIA' AND chave ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
  ),
  CONSTRAINT empresa_pix_nome_check CHECK (char_length(nome_recebedor) BETWEEN 1 AND 25 AND nome_recebedor = btrim(nome_recebedor)),
  CONSTRAINT empresa_pix_cidade_check CHECK (char_length(cidade_recebedor) BETWEEN 1 AND 15 AND cidade_recebedor = btrim(cidade_recebedor)),
  CONSTRAINT empresa_pix_versao_check CHECK (versao > 0)
);

COMMENT ON TABLE empresa_pix_recebimento IS
  '066: chave Pix da própria empresa para o BR Code estático das parcelas. A Kidmais não recebe nem repassa valores.';

COMMIT;
