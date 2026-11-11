-- 120 — Financeiro P2: liquidação parcial de entrada manual e reversão de pagamento de despesa.
-- Plano "Evolução do financeiro básico e avançado" rev. 3.2 (C.2, E.2), plano de execução FINANCEIRO_P2_PLANO_20261109.md.
-- LOCAL, preparada em 09/11/2026. NÃO aplicada em staging/produção. Exige a 052 (financeiro gerencial).
-- Só acréscimos. Nenhuma linha existente é alterada e não há backfill:
--   * financeiro_entradas_liquidacoes: cada recebimento de uma entrada manual, parcial ou total. Entrada antiga com
--     recebido_em e sem liquidação continua valendo como uma liquidação de (valor − taxa) naquela data (leitor da P2).
--   * financeiro_saidas_reversoes: devolução, ao caixa, de parte ou de todo um pagamento de despesa. A conta continua
--     existindo; o pago da conta passa a ser saídas − reversões.
--   * UNIQUE (id, empresa_id) em financeiro_entradas_manuais e financeiro_saidas, para as FKs compostas.
-- Os limites que dependem de soma (liquidado ≤ valor da entrada, revertido ≤ valor da saída) ficam no serviço, sob a
-- trava da linha de origem, como o pagamento de conta da 052.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;

DO $$ BEGIN
  IF to_regclass('public.empresas') IS NULL OR to_regclass('public.financeiro_entradas_manuais') IS NULL
     OR to_regclass('public.financeiro_saidas') IS NULL THEN
    RAISE EXCEPTION '120 exige empresas e a 052 (financeiro_entradas_manuais, financeiro_saidas).';
  END IF;
  IF to_regclass('public.financeiro_entradas_liquidacoes') IS NOT NULL OR to_regclass('public.financeiro_saidas_reversoes') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_constraint WHERE conname IN ('financeiro_entradas_manuais_empresa_uk', 'financeiro_saidas_empresa_uk')) THEN
    RAISE EXCEPTION '120 já (parcialmente) presente.';
  END IF;
END $$;

ALTER TABLE financeiro_entradas_manuais ADD CONSTRAINT financeiro_entradas_manuais_empresa_uk UNIQUE (id, empresa_id);
ALTER TABLE financeiro_saidas ADD CONSTRAINT financeiro_saidas_empresa_uk UNIQUE (id, empresa_id);

CREATE TABLE financeiro_entradas_liquidacoes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  entrada_id uuid NOT NULL,
  valor numeric(12,2) NOT NULL,
  taxa numeric(12,2) NOT NULL DEFAULT 0,
  recebido_em date NOT NULL,
  forma varchar(20) NOT NULL,
  observacao text,
  chave_idempotencia varchar(160) NOT NULL,
  criado_por uuid,
  criado_em timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT financeiro_entradas_liquidacoes_entrada_fk FOREIGN KEY (entrada_id, empresa_id)
    REFERENCES financeiro_entradas_manuais (id, empresa_id) ON DELETE RESTRICT,
  CONSTRAINT financeiro_entradas_liquidacoes_valor_check CHECK (valor > 0),
  CONSTRAINT financeiro_entradas_liquidacoes_taxa_check CHECK (taxa >= 0 AND taxa <= valor),
  CONSTRAINT financeiro_entradas_liquidacoes_forma_check CHECK (
    forma IN ('PIX', 'CARTAO_CREDITO', 'CARTAO_DEBITO', 'BOLETO', 'DINHEIRO', 'TRANSFERENCIA', 'OUTRO')
  ),
  CONSTRAINT financeiro_entradas_liquidacoes_idempotencia_uk UNIQUE (empresa_id, chave_idempotencia)
);
CREATE INDEX financeiro_entradas_liquidacoes_entrada_idx ON financeiro_entradas_liquidacoes (entrada_id);
CREATE INDEX financeiro_entradas_liquidacoes_data_idx ON financeiro_entradas_liquidacoes (empresa_id, recebido_em);

CREATE TABLE financeiro_saidas_reversoes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  saida_id uuid NOT NULL,
  valor numeric(12,2) NOT NULL,
  revertido_em date NOT NULL,
  motivo text NOT NULL,
  chave_idempotencia varchar(160) NOT NULL,
  criado_por uuid,
  criado_em timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT financeiro_saidas_reversoes_saida_fk FOREIGN KEY (saida_id, empresa_id)
    REFERENCES financeiro_saidas (id, empresa_id) ON DELETE RESTRICT,
  CONSTRAINT financeiro_saidas_reversoes_valor_check CHECK (valor > 0),
  CONSTRAINT financeiro_saidas_reversoes_motivo_check CHECK (length(btrim(motivo)) BETWEEN 3 AND 500),
  CONSTRAINT financeiro_saidas_reversoes_idempotencia_uk UNIQUE (empresa_id, chave_idempotencia)
);
CREATE INDEX financeiro_saidas_reversoes_saida_idx ON financeiro_saidas_reversoes (saida_id);
CREATE INDEX financeiro_saidas_reversoes_data_idx ON financeiro_saidas_reversoes (empresa_id, revertido_em);

COMMIT;
