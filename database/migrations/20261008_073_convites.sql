-- 073: Convites V1. Validada em fixture descartável; exige autorização para aplicar em cada ambiente.
-- Sem backfill, sem crédito automático e sem alteração de contratos existentes.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = public, pg_catalog;
CREATE TABLE convite_carteiras (
  empresa_id uuid PRIMARY KEY REFERENCES empresas(id),
  limite_mensal integer NOT NULL DEFAULT 0 CHECK (limite_mensal BETWEEN 0 AND 100000),
  ativo boolean NOT NULL DEFAULT false
);
CREATE TABLE convite_consumos (
  empresa_id uuid NOT NULL REFERENCES convite_carteiras(empresa_id),
  mes date NOT NULL, usado integer NOT NULL DEFAULT 0 CHECK (usado >= 0),
  PRIMARY KEY (empresa_id, mes)
);
CREATE TABLE convite_orcamento_global (
  dia date PRIMARY KEY, reservado_microusd bigint NOT NULL DEFAULT 0 CHECK (reservado_microusd >= 0)
);
CREATE TABLE convites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresas(id),
  festa_id uuid NOT NULL UNIQUE REFERENCES festas(id),
  estabelecimento_id uuid REFERENCES estabelecimentos(id),
  cliente_id uuid NOT NULL REFERENCES clientes(id),
  publico_token text NOT NULL UNIQUE CHECK (length(publico_token) = 43),
  editor_hash text UNIQUE, editor_expira_em timestamptz,
  rascunho jsonb NOT NULL, publicado jsonb,
  versao_contrato_id uuid NOT NULL REFERENCES contrato_versoes(id),
  limite_festa integer NOT NULL DEFAULT 3 CHECK (limite_festa BETWEEN 0 AND 100),
  limite_cliente integer NOT NULL DEFAULT 3 CHECK (limite_cliente BETWEEN 0 AND limite_festa),
  usado_festa integer NOT NULL DEFAULT 0 CHECK (usado_festa >= 0),
  usado_cliente integer NOT NULL DEFAULT 0 CHECK (usado_cliente BETWEEN 0 AND usado_festa),
  revisao integer NOT NULL DEFAULT 1,
  criado_em timestamptz NOT NULL DEFAULT now(), atualizado_em timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, empresa_id)
);
CREATE TABLE convite_artes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  convite_id uuid NOT NULL, empresa_id uuid NOT NULL,
  imagem bytea NOT NULL CHECK (octet_length(imagem) <= 1500000),
  origem text NOT NULL CHECK (origem IN ('UPLOAD','IA')),
  criado_em timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (convite_id, empresa_id) REFERENCES convites(id, empresa_id),
  UNIQUE (id, convite_id)
);
CREATE TABLE convite_geracoes (
  id uuid PRIMARY KEY, convite_id uuid NOT NULL, empresa_id uuid NOT NULL,
  ator text NOT NULL, payload_hash text NOT NULL,
  estado text NOT NULL DEFAULT 'RESERVADA' CHECK (estado IN ('RESERVADA','CONCLUIDA','INCERTA')),
  arte_id uuid REFERENCES convite_artes(id),
  modelo text NOT NULL, uso jsonb, criado_em timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (convite_id, empresa_id) REFERENCES convites(id, empresa_id)
);
CREATE UNIQUE INDEX convite_uma_geracao_pendente ON convite_geracoes(convite_id) WHERE estado='RESERVADA';
CREATE TABLE convite_respostas (
  convite_id uuid NOT NULL REFERENCES convites(id), chave uuid NOT NULL,
  nome varchar(100) NOT NULL, presenca boolean NOT NULL,
  adultos integer NOT NULL CHECK (adultos BETWEEN 0 AND 20),
  criancas integer NOT NULL CHECK (criancas BETWEEN 0 AND 20),
  atualizado_em timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(convite_id, chave)
);
CREATE TABLE convite_limites_http (
  chave text NOT NULL, janela timestamptz NOT NULL, usado integer NOT NULL DEFAULT 1,
  PRIMARY KEY(chave, janela)
);
CREATE TABLE convite_eventos (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  convite_id uuid NOT NULL REFERENCES convites(id), ator text NOT NULL,
  acao text NOT NULL, detalhe jsonb NOT NULL DEFAULT '{}', criado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX convite_eventos_convite ON convite_eventos(convite_id, id DESC);
-- Comprovação relacional: nem inserts manuais podem vincular festa de outra empresa/cliente/unidade.
CREATE FUNCTION convite_validar_vinculo() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM festas f JOIN contratos c ON c.id=f.contrato_id
    JOIN fechamentos fe ON fe.id=c.fechamento_id WHERE f.id=NEW.festa_id
      AND fe.empresa_id=NEW.empresa_id AND fe.cliente_id=NEW.cliente_id
      AND fe.estabelecimento_id IS NOT DISTINCT FROM NEW.estabelecimento_id) THEN
    RAISE EXCEPTION 'Vínculo do convite inválido';
  END IF;
  IF TG_OP='UPDATE' AND (NEW.empresa_id, NEW.festa_id, NEW.cliente_id, NEW.estabelecimento_id)
      IS DISTINCT FROM (OLD.empresa_id, OLD.festa_id, OLD.cliente_id, OLD.estabelecimento_id) THEN
    RAISE EXCEPTION 'Vínculo do convite imutável';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER convite_vinculo BEFORE INSERT OR UPDATE ON convites FOR EACH ROW EXECUTE FUNCTION convite_validar_vinculo();
COMMIT;
