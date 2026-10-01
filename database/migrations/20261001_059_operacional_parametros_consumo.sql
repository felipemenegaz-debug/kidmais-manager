-- 059 — IA operacional: fonte de negócio dos PARÂMETROS DE CONSUMO por empresa (doces e refrigerantes por convidado).
--
-- NÃO APLICADA. Exige autorização explícita (docs/OPERACAO_AGENTES.md) para qualquer banco, inclusive staging e clones.
-- Sem esta migration a IA operacional continua funcionando: o cálculo pergunta o parâmetro ao operador (vale só para
-- aquele cálculo) e a proposta de salvar como padrão responde que a fonte ainda não existe neste ambiente.
--
--   operacional_parametros_consumo  uma linha por VERSÃO da regra de uma categoria na empresa:
--   * categoria DOCES ⇒ quantidade_por_convidado (unidades inteiras); REFRIGERANTES ⇒ ml_por_convidado (mL inteiros)
--     e, opcionalmente, embalagem_ml (embalagem indivisível, arredondada para cima no cálculo);
--   * margem_percentual e distribuicao são opcionais (nunca presumidas pelo cálculo);
--   * no máximo UMA versão vigente por (empresa, categoria) — substituida_em IS NULL;
--   * versão imutável: só `substituida_em` muda, uma única vez (NULL → instante); sem DELETE nem TRUNCATE;
--   * autoria e auditoria na própria linha (criado_por, criado_em, origem) e idempotência por `operacao_id`
--     (a operação do Human Gate que gravou a versão: repetir a confirmação nunca cria outra versão).
-- Escrita só pelo serviço de domínio (lib/operacional/parametros-consumo.ts), chamado pelo Human Gate depois da
-- confirmação humana; a IA nunca escreve aqui diretamente e nunca guarda o padrão em skill, memória ou rascunho.
BEGIN;

DO $$ BEGIN
  IF to_regclass('public.empresas') IS NULL OR to_regclass('public.usuarios_administrativos') IS NULL THEN
    RAISE EXCEPTION '059 exige empresas e usuarios_administrativos.';
  END IF;
  IF to_regclass('public.operacional_parametros_consumo') IS NOT NULL THEN
    RAISE EXCEPTION '059 já aplicada.';
  END IF;
END $$;

CREATE TABLE operacional_parametros_consumo (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  categoria varchar(16) NOT NULL CHECK (categoria IN ('DOCES', 'REFRIGERANTES')),
  versao integer NOT NULL CHECK (versao BETWEEN 1 AND 100000),
  base varchar(16) NOT NULL DEFAULT 'CONVIDADO' CHECK (base = 'CONVIDADO'),
  quantidade_por_convidado integer CHECK (quantidade_por_convidado BETWEEN 1 AND 100),
  ml_por_convidado integer CHECK (ml_por_convidado BETWEEN 1 AND 5000),
  embalagem_ml integer CHECK (embalagem_ml BETWEEN 50 AND 20000),
  margem_percentual integer CHECK (margem_percentual BETWEEN 0 AND 100),
  distribuicao jsonb CHECK (distribuicao IS NULL OR (jsonb_typeof(distribuicao) = 'array' AND jsonb_array_length(distribuicao) BETWEEN 2 AND 10)),
  arredondamento varchar(24) NOT NULL CHECK (arredondamento IN ('UNIDADE_INTEIRA', 'EMBALAGEM_PARA_CIMA')),
  origem varchar(24) NOT NULL CHECK (origem IN ('KIDMAIS_INTELLIGENCE', 'TELA')),
  operacao_id uuid UNIQUE,
  vigente_desde timestamptz NOT NULL DEFAULT clock_timestamp(),
  substituida_em timestamptz,
  criado_por uuid NOT NULL REFERENCES usuarios_administrativos(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  criado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT operacional_059_categoria_check CHECK (
    (categoria = 'DOCES' AND quantidade_por_convidado IS NOT NULL AND ml_por_convidado IS NULL AND embalagem_ml IS NULL
      AND arredondamento = 'UNIDADE_INTEIRA')
    OR (categoria = 'REFRIGERANTES' AND ml_por_convidado IS NOT NULL AND quantidade_por_convidado IS NULL AND distribuicao IS NULL
      AND arredondamento = 'EMBALAGEM_PARA_CIMA')
  ),
  CONSTRAINT operacional_059_vigencia_check CHECK (substituida_em IS NULL OR substituida_em >= vigente_desde),
  CONSTRAINT operacional_059_versao_uk UNIQUE (empresa_id, categoria, versao)
);
CREATE UNIQUE INDEX operacional_059_uma_vigente_uk ON operacional_parametros_consumo (empresa_id, categoria) WHERE substituida_em IS NULL;

CREATE FUNCTION kidmais_059_parametro_guarda() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '059: exclusão de parâmetro recusada (substitua por nova versão).' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.empresa_id IS DISTINCT FROM OLD.empresa_id OR NEW.categoria IS DISTINCT FROM OLD.categoria
     OR NEW.versao IS DISTINCT FROM OLD.versao OR NEW.base IS DISTINCT FROM OLD.base
     OR NEW.quantidade_por_convidado IS DISTINCT FROM OLD.quantidade_por_convidado OR NEW.ml_por_convidado IS DISTINCT FROM OLD.ml_por_convidado
     OR NEW.embalagem_ml IS DISTINCT FROM OLD.embalagem_ml OR NEW.margem_percentual IS DISTINCT FROM OLD.margem_percentual
     OR NEW.distribuicao IS DISTINCT FROM OLD.distribuicao OR NEW.arredondamento IS DISTINCT FROM OLD.arredondamento
     OR NEW.origem IS DISTINCT FROM OLD.origem OR NEW.operacao_id IS DISTINCT FROM OLD.operacao_id
     OR NEW.vigente_desde IS DISTINCT FROM OLD.vigente_desde OR NEW.criado_por IS DISTINCT FROM OLD.criado_por
     OR NEW.criado_em IS DISTINCT FROM OLD.criado_em THEN
    RAISE EXCEPTION '059: versão de parâmetro é imutável; crie uma nova versão.' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.substituida_em IS NOT NULL THEN
    RAISE EXCEPTION '059: versão já substituída não muda.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION kidmais_059_bloquear_truncate() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION '059: TRUNCATE de operacional_parametros_consumo recusado.' USING ERRCODE = 'P0001';
END $$;

CREATE TRIGGER operacional_059_guarda_trg BEFORE UPDATE OR DELETE ON operacional_parametros_consumo
  FOR EACH ROW EXECUTE FUNCTION kidmais_059_parametro_guarda();
CREATE TRIGGER operacional_059_truncate_trg BEFORE TRUNCATE ON operacional_parametros_consumo
  FOR EACH STATEMENT EXECUTE FUNCTION kidmais_059_bloquear_truncate();

COMMIT;
