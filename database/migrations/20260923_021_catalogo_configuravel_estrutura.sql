BEGIN;

-- V1-CAT-2C / 021A: estrutura aditiva. Não ativa leitura dinâmica, não migra
-- fechamentos antigos e não altera preços vigentes. A 017 já existe na V1;
-- o número 020 está reservado para a Foundation SaaS em outra branch.
DO $$ BEGIN
  IF to_regclass('public.pacotes') IS NULL OR
     to_regclass('public.adicionais') IS NULL OR
     to_regclass('public.precos_adicional') IS NULL OR
     to_regclass('public.fechamentos') IS NULL OR
     to_regprocedure('public.kidmais_set_atualizado_em()') IS NULL THEN
    RAISE EXCEPTION 'Migration 021 exige o núcleo comercial e de Fechamento da V1.';
  END IF;
END $$;

CREATE TABLE buffet_categorias (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo varchar(80) NOT NULL UNIQUE CHECK (btrim(codigo) <> ''),
  nome text NOT NULL CHECK (btrim(nome) <> ''),
  descricao text,
  ordem_exibicao integer NOT NULL DEFAULT 1 CHECK (ordem_exibicao > 0),
  ativo boolean NOT NULL DEFAULT true,
  arquivado_em timestamptz,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT buffet_categorias_arquivo_check CHECK (arquivado_em IS NULL OR NOT ativo)
);
CREATE INDEX buffet_categorias_ativas_idx ON buffet_categorias (ordem_exibicao, nome) WHERE ativo;
CREATE TRIGGER buffet_categorias_atualizado_em_trg BEFORE UPDATE ON buffet_categorias
  FOR EACH ROW EXECUTE FUNCTION kidmais_set_atualizado_em();

CREATE TABLE buffet_itens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  categoria_id uuid NOT NULL REFERENCES buffet_categorias(id) ON DELETE RESTRICT,
  codigo varchar(80) NOT NULL CHECK (btrim(codigo) <> ''),
  nome text NOT NULL CHECK (btrim(nome) <> ''),
  descricao text,
  ordem_exibicao integer NOT NULL DEFAULT 1 CHECK (ordem_exibicao > 0),
  ativo boolean NOT NULL DEFAULT true,
  arquivado_em timestamptz,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT buffet_itens_categoria_codigo_uk UNIQUE (categoria_id, codigo),
  CONSTRAINT buffet_itens_id_categoria_uk UNIQUE (id, categoria_id),
  CONSTRAINT buffet_itens_arquivo_check CHECK (arquivado_em IS NULL OR NOT ativo)
);
CREATE INDEX buffet_itens_ativos_idx ON buffet_itens (categoria_id, ordem_exibicao, nome) WHERE ativo;
CREATE TRIGGER buffet_itens_atualizado_em_trg BEFORE UPDATE ON buffet_itens
  FOR EACH ROW EXECUTE FUNCTION kidmais_set_atualizado_em();

CREATE TABLE pacote_buffet_categorias (
  pacote_id uuid NOT NULL REFERENCES pacotes(id) ON DELETE RESTRICT,
  categoria_id uuid NOT NULL REFERENCES buffet_categorias(id) ON DELETE RESTRICT,
  modo_itens varchar(20) NOT NULL CHECK (modo_itens IN ('TODOS_ATIVOS','SELECIONADOS')),
  escolhas_min smallint NOT NULL DEFAULT 0 CHECK (escolhas_min >= 0),
  escolhas_max smallint NOT NULL CHECK (escolhas_max > 0),
  ativo boolean NOT NULL DEFAULT true,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (pacote_id, categoria_id),
  CONSTRAINT pacote_buffet_limites_check CHECK (escolhas_max >= escolhas_min)
);
CREATE INDEX pacote_buffet_categorias_ativas_idx ON pacote_buffet_categorias (pacote_id) WHERE ativo;
CREATE TRIGGER pacote_buffet_categorias_atualizado_em_trg BEFORE UPDATE ON pacote_buffet_categorias
  FOR EACH ROW EXECUTE FUNCTION kidmais_set_atualizado_em();

CREATE TABLE pacote_buffet_itens (
  pacote_id uuid NOT NULL,
  categoria_id uuid NOT NULL,
  item_id uuid NOT NULL,
  criado_em timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (pacote_id, categoria_id, item_id),
  CONSTRAINT pacote_buffet_itens_regra_fk FOREIGN KEY (pacote_id, categoria_id)
    REFERENCES pacote_buffet_categorias(pacote_id, categoria_id) ON DELETE RESTRICT,
  CONSTRAINT pacote_buffet_itens_categoria_fk FOREIGN KEY (item_id, categoria_id)
    REFERENCES buffet_itens(id, categoria_id) ON DELETE RESTRICT
);

-- Um lote por consolidação conserva revisões sucessivas sem reescrever escolhas
-- anteriores. A API associará o lote à versão contratual quando esta existir.
CREATE TABLE fechamento_buffet_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fechamento_id uuid NOT NULL REFERENCES fechamentos(id) ON DELETE RESTRICT,
  contrato_versao_id uuid REFERENCES contrato_versoes(id) ON DELETE RESTRICT,
  criado_em timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX fechamento_buffet_snapshots_versao_uk
  ON fechamento_buffet_snapshots (contrato_versao_id) WHERE contrato_versao_id IS NOT NULL;
CREATE INDEX fechamento_buffet_snapshots_fechamento_idx
  ON fechamento_buffet_snapshots (fechamento_id, criado_em DESC);

-- O fechamento continua com suas colunas buffet_* até a transição completa.
-- Os nomes são copiados no marco comercial; IDs permanecem para rastreabilidade.
CREATE TABLE fechamento_buffet_escolhas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id uuid NOT NULL REFERENCES fechamento_buffet_snapshots(id) ON DELETE RESTRICT,
  categoria_id uuid NOT NULL REFERENCES buffet_categorias(id) ON DELETE RESTRICT,
  item_id uuid NOT NULL,
  categoria_nome_aplicado text NOT NULL CHECK (btrim(categoria_nome_aplicado) <> ''),
  item_nome_aplicado text NOT NULL CHECK (btrim(item_nome_aplicado) <> ''),
  ordem_aplicada integer NOT NULL CHECK (ordem_aplicada > 0),
  criado_em timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fechamento_buffet_escolhas_item_fk FOREIGN KEY (item_id, categoria_id)
    REFERENCES buffet_itens(id, categoria_id) ON DELETE RESTRICT,
  CONSTRAINT fechamento_buffet_escolhas_uk UNIQUE (snapshot_id, categoria_id, item_id)
);
CREATE INDEX fechamento_buffet_escolhas_snapshot_idx ON fechamento_buffet_escolhas (snapshot_id, ordem_aplicada);

-- A coluna texto 'categoria' de adicionais permanece para a V1 existente.
-- codigo é estável; o nome da categoria poderá mudar sem alterar esse código.
CREATE TABLE adicional_categorias (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo varchar(40) NOT NULL UNIQUE CHECK (btrim(codigo) <> ''),
  nome text NOT NULL CHECK (btrim(nome) <> ''),
  ordem_exibicao integer NOT NULL DEFAULT 1 CHECK (ordem_exibicao > 0),
  ativo boolean NOT NULL DEFAULT true,
  arquivado_em timestamptz,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT adicional_categorias_arquivo_check CHECK (arquivado_em IS NULL OR NOT ativo),
  CONSTRAINT adicional_categorias_id_codigo_uk UNIQUE (id, codigo)
);
CREATE TRIGGER adicional_categorias_atualizado_em_trg BEFORE UPDATE ON adicional_categorias
  FOR EACH ROW EXECUTE FUNCTION kidmais_set_atualizado_em();
CREATE INDEX adicional_categorias_ativas_idx ON adicional_categorias (ordem_exibicao, nome) WHERE ativo;
INSERT INTO adicional_categorias (codigo, nome, ordem_exibicao)
SELECT categoria, initcap(replace(categoria, '_', ' ')), row_number() OVER (ORDER BY categoria)::integer
FROM (SELECT DISTINCT categoria FROM adicionais) AS existentes;
ALTER TABLE adicionais ADD COLUMN categoria_id uuid;
UPDATE adicionais a SET categoria_id = c.id FROM adicional_categorias c WHERE c.codigo = a.categoria;
ALTER TABLE adicionais ALTER COLUMN categoria_id SET NOT NULL;
ALTER TABLE adicionais ADD CONSTRAINT adicionais_categoria_id_codigo_fk
  FOREIGN KEY (categoria_id, categoria) REFERENCES adicional_categorias(id, codigo) ON DELETE RESTRICT;
CREATE INDEX adicionais_categoria_id_idx ON adicionais (categoria_id, ordem_exibicao) WHERE ativo;

-- Ausência de vínculo significa indisponível: a API futura deve falhar fechada.
-- Um extra de item incluso precisa ser um adicional distinto e explicitamente nomeado.
CREATE TABLE pacote_adicionais (
  pacote_id uuid NOT NULL REFERENCES pacotes(id) ON DELETE RESTRICT,
  adicional_id uuid NOT NULL REFERENCES adicionais(id) ON DELETE RESTRICT,
  modalidade varchar(20) NOT NULL CHECK (modalidade IN ('INCLUSO','EXTRA','INDISPONIVEL')),
  ativo boolean NOT NULL DEFAULT true,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (pacote_id, adicional_id)
);
CREATE INDEX pacote_adicionais_ativos_idx ON pacote_adicionais (pacote_id, modalidade) WHERE ativo;
CREATE TRIGGER pacote_adicionais_atualizado_em_trg BEFORE UPDATE ON pacote_adicionais
  FOR EACH ROW EXECUTE FUNCTION kidmais_set_atualizado_em();

-- Cortesias são válidas, preservando snapshots financeiros já existentes.
ALTER TABLE precos_adicional DROP CONSTRAINT precos_adicional_valor_check;
ALTER TABLE precos_adicional ADD CONSTRAINT precos_adicional_valor_check CHECK (valor >= 0);

-- Metadados apenas. O upload e a troca atômica do arquivo serão implementados
-- na API; a migration não grava PDF no banco nem publica documento.
CREATE TABLE documentos_publicos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo varchar(40) NOT NULL CHECK (tipo = 'TABELA_PACOTES_PRECOS'),
  nome_arquivo text NOT NULL CHECK (btrim(nome_arquivo) <> ''),
  mime_type varchar(40) NOT NULL CHECK (mime_type = 'application/pdf'),
  tamanho_bytes bigint NOT NULL CHECK (tamanho_bytes > 0),
  sha256 char(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  chave_armazenamento text NOT NULL UNIQUE CHECK (btrim(chave_armazenamento) <> ''),
  ativo boolean NOT NULL DEFAULT false,
  criado_em timestamptz NOT NULL DEFAULT now(),
  publicado_em timestamptz,
  CONSTRAINT documentos_publicos_vigencia_check CHECK (NOT ativo OR publicado_em IS NOT NULL)
);
CREATE UNIQUE INDEX documentos_publicos_um_ativo_idx ON documentos_publicos (tipo) WHERE ativo;

COMMIT;
