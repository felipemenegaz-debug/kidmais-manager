-- Contas a pagar, auditoria e entradas manuais do financeiro gerencial.
-- Recebíveis de contrato continuam em pagamento_parcelas e pagamento_recebimentos.
BEGIN;

DO $$ BEGIN
  IF to_regclass('public.empresas') IS NULL OR to_regclass('public.festas') IS NULL THEN
    RAISE EXCEPTION '052 exige empresas e festas.';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS financeiro_categorias (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  tipo varchar(10) NOT NULL,
  nome varchar(80) NOT NULL,
  ativo boolean NOT NULL DEFAULT true,
  criado_em timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT financeiro_categorias_tipo_check CHECK (tipo IN ('DESPESA', 'RECEITA')),
  CONSTRAINT financeiro_categorias_nome_uk UNIQUE (empresa_id, tipo, nome),
  CONSTRAINT financeiro_categorias_empresa_uk UNIQUE (id, empresa_id)
);

CREATE TABLE IF NOT EXISTS financeiro_recorrencias (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  periodicidade varchar(10) NOT NULL DEFAULT 'MENSAL',
  horizonte_meses smallint NOT NULL DEFAULT 12,
  chave_idempotencia varchar(160),
  criado_em timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT financeiro_recorrencias_periodo_check CHECK (periodicidade = 'MENSAL'),
  CONSTRAINT financeiro_recorrencias_horizonte_check CHECK (horizonte_meses BETWEEN 1 AND 24),
  CONSTRAINT financeiro_recorrencias_chave_uk UNIQUE (empresa_id, chave_idempotencia)
);

CREATE TABLE IF NOT EXISTS financeiro_contas_pagar (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  categoria_id uuid NOT NULL REFERENCES financeiro_categorias(id) ON DELETE RESTRICT,
  recorrencia_id uuid REFERENCES financeiro_recorrencias(id) ON DELETE RESTRICT,
  festa_id uuid REFERENCES festas(id) ON DELETE RESTRICT,
  descricao varchar(160) NOT NULL,
  favorecido varchar(160),
  valor numeric(12,2) NOT NULL,
  vencimento date NOT NULL,
  competencia date,
  forma varchar(20),
  observacao text,
  cancelado_em timestamptz,
  chave_criacao varchar(160),
  criado_por uuid,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT financeiro_contas_pagar_valor_check CHECK (valor > 0),
  CONSTRAINT financeiro_contas_pagar_forma_check CHECK (
    forma IS NULL OR forma IN ('PIX', 'CARTAO_CREDITO', 'CARTAO_DEBITO', 'BOLETO', 'DINHEIRO', 'TRANSFERENCIA', 'OUTRO')
  ),
  CONSTRAINT financeiro_contas_pagar_ocorrencia_uk UNIQUE (recorrencia_id, vencimento),
  CONSTRAINT financeiro_contas_pagar_criacao_uk UNIQUE (empresa_id, chave_criacao),
  CONSTRAINT financeiro_contas_pagar_categoria_empresa_fk
    FOREIGN KEY (categoria_id, empresa_id) REFERENCES financeiro_categorias (id, empresa_id)
);

CREATE INDEX IF NOT EXISTS financeiro_contas_pagar_empresa_idx
  ON financeiro_contas_pagar (empresa_id, vencimento);

CREATE TABLE IF NOT EXISTS financeiro_saidas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  conta_id uuid NOT NULL REFERENCES financeiro_contas_pagar(id) ON DELETE RESTRICT,
  valor numeric(12,2) NOT NULL,
  pago_em date NOT NULL,
  forma varchar(20) NOT NULL,
  observacao text,
  chave_idempotencia varchar(160) NOT NULL,
  criado_por uuid,
  criado_em timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT financeiro_saidas_valor_check CHECK (valor > 0),
  CONSTRAINT financeiro_saidas_forma_check CHECK (
    forma IN ('PIX', 'CARTAO_CREDITO', 'CARTAO_DEBITO', 'BOLETO', 'DINHEIRO', 'TRANSFERENCIA', 'OUTRO')
  ),
  CONSTRAINT financeiro_saidas_idempotencia_uk UNIQUE (empresa_id, chave_idempotencia)
);

CREATE INDEX IF NOT EXISTS financeiro_saidas_conta_idx ON financeiro_saidas (conta_id);
CREATE INDEX IF NOT EXISTS financeiro_saidas_empresa_data_idx ON financeiro_saidas (empresa_id, pago_em);

-- A 052 pode já ter sido criada nesta revisão local. O bloco abaixo alinha o contrato
-- sem recriar tabela: idempotência por empresa, categoria da mesma empresa e chave da série.
ALTER TABLE financeiro_recorrencias ADD COLUMN IF NOT EXISTS chave_idempotencia varchar(160);
ALTER TABLE financeiro_contas_pagar ADD COLUMN IF NOT EXISTS chave_criacao varchar(160);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'financeiro_categorias_empresa_uk') THEN
    ALTER TABLE financeiro_categorias
      ADD CONSTRAINT financeiro_categorias_empresa_uk UNIQUE (id, empresa_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'financeiro_recorrencias_chave_uk') THEN
    ALTER TABLE financeiro_recorrencias
      ADD CONSTRAINT financeiro_recorrencias_chave_uk UNIQUE (empresa_id, chave_idempotencia);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'financeiro_contas_pagar_criacao_uk') THEN
    ALTER TABLE financeiro_contas_pagar
      ADD CONSTRAINT financeiro_contas_pagar_criacao_uk UNIQUE (empresa_id, chave_criacao);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'financeiro_contas_pagar_categoria_empresa_fk') THEN
    ALTER TABLE financeiro_contas_pagar
      ADD CONSTRAINT financeiro_contas_pagar_categoria_empresa_fk
      FOREIGN KEY (categoria_id, empresa_id) REFERENCES financeiro_categorias (id, empresa_id);
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'financeiro_saidas_idempotencia_uk'
       AND pg_get_constraintdef(oid) NOT ILIKE '%empresa_id%'
  ) THEN
    ALTER TABLE financeiro_saidas DROP CONSTRAINT financeiro_saidas_idempotencia_uk;
    ALTER TABLE financeiro_saidas
      ADD CONSTRAINT financeiro_saidas_idempotencia_uk UNIQUE (empresa_id, chave_idempotencia);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'financeiro_recorrencias_horizonte_check') THEN
    ALTER TABLE financeiro_recorrencias DROP CONSTRAINT financeiro_recorrencias_horizonte_check;
  END IF;
  ALTER TABLE financeiro_recorrencias
    ADD CONSTRAINT financeiro_recorrencias_horizonte_check CHECK (horizonte_meses BETWEEN 1 AND 24);
END $$;

CREATE TABLE IF NOT EXISTS financeiro_auditoria (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  acao varchar(40) NOT NULL,
  entidade varchar(40) NOT NULL,
  entidade_id uuid NOT NULL,
  ator_id uuid,
  detalhe text NOT NULL,
  criado_em timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE financeiro_contas_pagar IS
  'Obrigação de saída da empresa. Vencido não é gravado: deriva do vencimento e do saldo.';

CREATE TABLE IF NOT EXISTS financeiro_entradas_manuais (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  descricao varchar(160) NOT NULL,
  contraparte varchar(160),
  festa_id uuid REFERENCES festas(id) ON DELETE RESTRICT,
  valor numeric(12,2) NOT NULL,
  vencimento date NOT NULL,
  forma varchar(20),
  observacao text,
  recebido_em date,
  taxa numeric(12,2) NOT NULL DEFAULT 0,
  historico boolean NOT NULL DEFAULT false,
  chave_criacao varchar(160) NOT NULL,
  criado_por uuid,
  criado_em timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT financeiro_entradas_manuais_valor_check CHECK (valor > 0),
  CONSTRAINT financeiro_entradas_manuais_taxa_check CHECK (taxa >= 0 AND taxa <= valor),
  CONSTRAINT financeiro_entradas_manuais_recebimento_check CHECK (recebido_em IS NOT NULL OR taxa = 0),
  CONSTRAINT financeiro_entradas_manuais_forma_check CHECK (
    forma IS NULL OR forma IN ('PIX', 'CARTAO_CREDITO', 'CARTAO_DEBITO', 'BOLETO', 'DINHEIRO', 'TRANSFERENCIA', 'OUTRO')
  ),
  CONSTRAINT financeiro_entradas_manuais_criacao_uk UNIQUE (empresa_id, chave_criacao)
);

CREATE INDEX IF NOT EXISTS financeiro_entradas_manuais_empresa_idx
  ON financeiro_entradas_manuais (empresa_id, vencimento);

COMMENT ON TABLE financeiro_entradas_manuais IS
  'Entrada manual, origem ENTRADA_MANUAL. Não nasce de contrato nem de festa fictícia. Vencido deriva do saldo e do vencimento.';

COMMIT;
