BEGIN;

-- Fotografia append-only do pacote no fechamento.
-- Não copia extras pagos, escolhas do cliente nem cardápio.
-- Não preenche duração artificial e não faz backfill de fechamentos antigos.
DO $$ BEGIN
  IF to_regclass('public.fechamentos') IS NULL
     OR to_regclass('public.pacotes') IS NULL
     OR to_regclass('public.tabelas_preco') IS NULL
     OR to_regclass('public.precos_pacote') IS NULL
     OR to_regclass('public.regras_desconto_pacote') IS NULL
     OR to_regclass('public.adicionais') IS NULL
     OR to_regclass('public.pacote_adicionais') IS NULL
     OR to_regclass('public.buffet_categorias') IS NULL
     OR to_regclass('public.pacote_buffet_categorias') IS NULL
     OR to_regclass('public.usuarios_administrativos') IS NULL THEN
    RAISE EXCEPTION '029: núcleo comercial ou de fechamento ausente.';
  END IF;
  IF to_regclass('public.fechamento_pacote_snapshots') IS NOT NULL
     OR to_regclass('public.fechamento_pacote_composicao') IS NOT NULL THEN
    RAISE EXCEPTION '029: fotografia de pacote já existe.';
  END IF;
END $$;

CREATE TABLE fechamento_pacote_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fechamento_id uuid NOT NULL,
  sequencia integer NOT NULL,
  pacote_id uuid NOT NULL,
  codigo_aplicado varchar(50) NOT NULL,
  nome_aplicado text NOT NULL,
  descricao_aplicada text,
  duracao_minutos_aplicada smallint,
  tabela_preco_id uuid NOT NULL,
  tabela_codigo_aplicado varchar(50) NOT NULL,
  tabela_nome_aplicado text NOT NULL,
  preco_pacote_id uuid NOT NULL,
  regra_desconto_pacote_id uuid,
  codigo_regra_desconto text,
  titulo_regra_desconto text,
  tipo_calculo varchar(20) NOT NULL,
  convidados_min_faixa smallint NOT NULL,
  convidados_max_faixa smallint,
  categoria_preco_linha varchar(20) NOT NULL,
  valor_linha numeric(12,2) NOT NULL,
  categoria_horario varchar(20) NOT NULL,
  categoria_preco_aplicada varchar(20) NOT NULL,
  convidados smallint NOT NULL,
  convidados_faturados smallint NOT NULL,
  desconto_percentual numeric(5,2) NOT NULL,
  valor_pacote_base numeric(12,2) NOT NULL,
  valor_desconto_pacote numeric(12,2) NOT NULL,
  valor_pacote_aplicado numeric(12,2) NOT NULL,
  valor_adicionais numeric(12,2) NOT NULL,
  valor_tabela numeric(12,2) NOT NULL,
  motivo text,
  ator_usuario_id uuid,
  snapshot_anterior_id uuid,
  criado_em timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fechamento_pacote_snapshots_fechamento_fk
    FOREIGN KEY (fechamento_id) REFERENCES fechamentos(id) ON DELETE RESTRICT,
  CONSTRAINT fechamento_pacote_snapshots_pacote_fk
    FOREIGN KEY (pacote_id) REFERENCES pacotes(id) ON DELETE RESTRICT,
  CONSTRAINT fechamento_pacote_snapshots_tabela_fk
    FOREIGN KEY (tabela_preco_id) REFERENCES tabelas_preco(id) ON DELETE RESTRICT,
  CONSTRAINT fechamento_pacote_snapshots_preco_fk
    FOREIGN KEY (preco_pacote_id) REFERENCES precos_pacote(id) ON DELETE RESTRICT,
  CONSTRAINT fechamento_pacote_snapshots_desconto_fk
    FOREIGN KEY (regra_desconto_pacote_id) REFERENCES regras_desconto_pacote(id) ON DELETE RESTRICT,
  CONSTRAINT fechamento_pacote_snapshots_ator_fk
    FOREIGN KEY (ator_usuario_id) REFERENCES usuarios_administrativos(id) ON DELETE RESTRICT,
  CONSTRAINT fechamento_pacote_snapshots_anterior_fk
    FOREIGN KEY (snapshot_anterior_id) REFERENCES fechamento_pacote_snapshots(id) ON DELETE RESTRICT,
  CONSTRAINT fechamento_pacote_snapshots_id_fechamento_uk UNIQUE (id, fechamento_id),
  CONSTRAINT fechamento_pacote_snapshots_sequencia_uk UNIQUE (fechamento_id, sequencia),
  CONSTRAINT fechamento_pacote_snapshots_sequencia_check CHECK (sequencia > 0),
  CONSTRAINT fechamento_pacote_snapshots_codigo_check CHECK (btrim(codigo_aplicado) <> ''),
  CONSTRAINT fechamento_pacote_snapshots_nome_check CHECK (btrim(nome_aplicado) <> ''),
  CONSTRAINT fechamento_pacote_snapshots_duracao_check CHECK (
    duracao_minutos_aplicada IS NULL OR duracao_minutos_aplicada > 0
  ),
  CONSTRAINT fechamento_pacote_snapshots_tipo_check CHECK (tipo_calculo IN ('FIXO', 'POR_CONVIDADO')),
  CONSTRAINT fechamento_pacote_snapshots_faixa_check CHECK (
    convidados_min_faixa > 0
    AND (convidados_max_faixa IS NULL OR convidados_max_faixa >= convidados_min_faixa)
  ),
  CONSTRAINT fechamento_pacote_snapshots_categoria_linha_check CHECK (
    categoria_preco_linha IN ('GERAL', 'PADRAO', 'NOBRE')
  ),
  CONSTRAINT fechamento_pacote_snapshots_categoria_horario_check CHECK (
    categoria_horario IN ('PADRAO', 'NOBRE')
  ),
  CONSTRAINT fechamento_pacote_snapshots_categoria_aplicada_check CHECK (
    categoria_preco_aplicada IN ('GERAL', 'PADRAO', 'NOBRE')
  ),
  CONSTRAINT fechamento_pacote_snapshots_convidados_check CHECK (
    convidados > 0 AND convidados_faturados >= convidados
  ),
  CONSTRAINT fechamento_pacote_snapshots_valores_check CHECK (
    valor_linha > 0
    AND valor_pacote_base > 0
    AND valor_pacote_aplicado > 0
    AND valor_tabela > 0
    AND valor_desconto_pacote >= 0
    AND valor_adicionais >= 0
    AND desconto_percentual >= 0
    AND desconto_percentual <= 100
  ),
  CONSTRAINT fechamento_pacote_snapshots_motivo_check CHECK (
    motivo IS NULL OR length(btrim(motivo)) >= 3
  )
);

CREATE INDEX fechamento_pacote_snapshots_fechamento_idx
  ON fechamento_pacote_snapshots (fechamento_id, sequencia);

CREATE TABLE fechamento_pacote_composicao (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id uuid NOT NULL,
  tipo varchar(20) NOT NULL,
  adicional_id uuid,
  categoria_id uuid,
  codigo_aplicado text NOT NULL,
  nome_aplicado text NOT NULL,
  modo_itens varchar(20),
  escolhas_min smallint,
  escolhas_max smallint,
  criado_em timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fechamento_pacote_composicao_snapshot_fk
    FOREIGN KEY (snapshot_id) REFERENCES fechamento_pacote_snapshots(id) ON DELETE RESTRICT,
  CONSTRAINT fechamento_pacote_composicao_adicional_fk
    FOREIGN KEY (adicional_id) REFERENCES adicionais(id) ON DELETE RESTRICT,
  CONSTRAINT fechamento_pacote_composicao_categoria_fk
    FOREIGN KEY (categoria_id) REFERENCES buffet_categorias(id) ON DELETE RESTRICT,
  CONSTRAINT fechamento_pacote_composicao_tipo_check CHECK (tipo IN ('INCLUSO', 'BUFFET')),
  CONSTRAINT fechamento_pacote_composicao_texto_check CHECK (
    btrim(codigo_aplicado) <> '' AND btrim(nome_aplicado) <> ''
  ),
  CONSTRAINT fechamento_pacote_composicao_forma_check CHECK (
    (
      tipo = 'INCLUSO'
      AND adicional_id IS NOT NULL
      AND categoria_id IS NULL
      AND modo_itens IS NULL
      AND escolhas_min IS NULL
      AND escolhas_max IS NULL
    )
    OR (
      tipo = 'BUFFET'
      AND adicional_id IS NULL
      AND categoria_id IS NOT NULL
      AND modo_itens IN ('TODOS_ATIVOS', 'SELECIONADOS')
      AND escolhas_min IS NOT NULL
      AND escolhas_max IS NOT NULL
      AND escolhas_min >= 0
      AND escolhas_max > 0
      AND escolhas_max >= escolhas_min
    )
  )
);

CREATE UNIQUE INDEX fechamento_pacote_composicao_incluso_uk
  ON fechamento_pacote_composicao (snapshot_id, adicional_id)
  WHERE tipo = 'INCLUSO';
CREATE UNIQUE INDEX fechamento_pacote_composicao_buffet_uk
  ON fechamento_pacote_composicao (snapshot_id, categoria_id)
  WHERE tipo = 'BUFFET';

CREATE FUNCTION kidmais_029_fotografia_imutavel()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Fotografia histórica do pacote é imutável' USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER fechamento_pacote_snapshots_imutavel
  BEFORE UPDATE OR DELETE ON fechamento_pacote_snapshots
  FOR EACH ROW EXECUTE FUNCTION kidmais_029_fotografia_imutavel();

CREATE TRIGGER fechamento_pacote_composicao_imutavel
  BEFORE UPDATE OR DELETE ON fechamento_pacote_composicao
  FOR EACH ROW EXECUTE FUNCTION kidmais_029_fotografia_imutavel();

ALTER TABLE fechamentos
  ADD COLUMN pacote_snapshot_vigente_id uuid;

ALTER TABLE fechamentos
  ADD CONSTRAINT fechamentos_pacote_snapshot_vigente_fk
  FOREIGN KEY (pacote_snapshot_vigente_id, id)
  REFERENCES fechamento_pacote_snapshots (id, fechamento_id)
  ON DELETE RESTRICT;

COMMIT;
