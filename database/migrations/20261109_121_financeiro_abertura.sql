-- 121 — Financeiro P2: abertura de saldo com revisões e conferência (plano rev. 3.2, C.2, C.2.1, C.2.2, D-FIN-9/10).
-- LOCAL, preparada em 09/11/2026. NÃO aplicada em staging/produção. Exige empresas e a 052.
-- Só acréscimos:
--   * financeiro_aberturas: revisões só por acréscimo. A vigente é a de maior versão da empresa. Saldo pode ser negativo
--     e nunca é receita. data_base é D0: o saldo informado é o de imediatamente antes dos movimentos de D0.
--   * financeiro_abertura_conferencias: histórico das conferências de origens tipadas numa revisão, com o hash dos
--     atributos vistos. modo PREVIA = conjunto conferido na confirmação (sequencia 1); CONFERIDO = pendência resolvida
--     depois pela Gestão. Se os atributos mudam depois de conferidos (H1 → H2), a origem volta a ficar pendente e pode
--     ser conferida de novo: uma nova linha com sequencia = máxima da origem + 1. Vale a de maior sequencia da origem.
--     O escritor (fase B) calcula a sequência sob trava da revisão (SELECT … FOR UPDATE em financeiro_aberturas) e
--     repete a mesma chave_idempotencia numa nova tentativa; a unicidade da sequência impede duas "últimas".
-- Sem abertura, nenhuma superfície mostra saldo absoluto (leitor da P2). A tabela fica vazia até alguém confirmar.
-- Revisões e conferências não são atualizadas nem apagadas: o gatilho recusa UPDATE e DELETE.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;

DO $$ BEGIN
  IF to_regclass('public.empresas') IS NULL OR to_regclass('public.financeiro_auditoria') IS NULL THEN
    RAISE EXCEPTION '121 exige empresas e a 052.';
  END IF;
  IF to_regclass('public.financeiro_aberturas') IS NOT NULL OR to_regclass('public.financeiro_abertura_conferencias') IS NOT NULL
     OR to_regprocedure('public.kidmais_121_somente_acrescimo()') IS NOT NULL THEN
    RAISE EXCEPTION '121 já (parcialmente) presente.';
  END IF;
END $$;

CREATE FUNCTION kidmais_121_somente_acrescimo() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
  AS $$ BEGIN
    RAISE EXCEPTION 'abertura do financeiro: revisões e conferências só por acréscimo (%).', TG_TABLE_NAME
      USING ERRCODE = 'check_violation';
  END $$;

CREATE TABLE financeiro_aberturas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  versao integer NOT NULL,
  data_base date NOT NULL,
  saldo numeric(14,2) NOT NULL,
  justificativa text NOT NULL,
  conjunto_hash char(64) NOT NULL,
  substitui_id uuid,
  chave_idempotencia varchar(160) NOT NULL,
  criado_por uuid NOT NULL,
  criado_em timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT financeiro_aberturas_empresa_uk UNIQUE (id, empresa_id),
  CONSTRAINT financeiro_aberturas_versao_uk UNIQUE (empresa_id, versao),
  CONSTRAINT financeiro_aberturas_idempotencia_uk UNIQUE (empresa_id, chave_idempotencia),
  CONSTRAINT financeiro_aberturas_substitui_fk FOREIGN KEY (substitui_id, empresa_id)
    REFERENCES financeiro_aberturas (id, empresa_id) ON DELETE RESTRICT,
  CONSTRAINT financeiro_aberturas_versao_check CHECK (versao >= 1),
  CONSTRAINT financeiro_aberturas_cadeia_check CHECK ((versao = 1) = (substitui_id IS NULL)),
  CONSTRAINT financeiro_aberturas_justificativa_check CHECK (length(btrim(justificativa)) BETWEEN 3 AND 1000),
  CONSTRAINT financeiro_aberturas_hash_check CHECK (conjunto_hash ~ '^[0-9a-f]{64}$')
);

CREATE TABLE financeiro_abertura_conferencias (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  abertura_id uuid NOT NULL,
  origem_tipo varchar(24) NOT NULL,
  origem_id uuid NOT NULL,
  atributos_hash char(64) NOT NULL,
  modo varchar(12) NOT NULL,
  sequencia integer NOT NULL,
  chave_idempotencia varchar(160) NOT NULL,
  criado_por uuid NOT NULL,
  criado_em timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT financeiro_abertura_conferencias_abertura_fk FOREIGN KEY (abertura_id, empresa_id)
    REFERENCES financeiro_aberturas (id, empresa_id) ON DELETE RESTRICT,
  CONSTRAINT financeiro_abertura_conferencias_origem_uk UNIQUE (abertura_id, origem_tipo, origem_id, sequencia),
  CONSTRAINT financeiro_abertura_conferencias_idempotencia_uk UNIQUE (empresa_id, chave_idempotencia),
  CONSTRAINT financeiro_abertura_conferencias_sequencia_check CHECK (sequencia >= 1),
  CONSTRAINT financeiro_abertura_conferencias_previa_check CHECK (modo <> 'PREVIA' OR sequencia = 1),
  CONSTRAINT financeiro_abertura_conferencias_tipo_check CHECK (origem_tipo IN (
    'RECEBIMENTO', 'ENTRADA_MANUAL', 'LIQUIDACAO_MANUAL', 'SAIDA', 'REVERSAO_SAIDA', 'ESTORNO', 'DEVOLUCAO'
  )),
  CONSTRAINT financeiro_abertura_conferencias_modo_check CHECK (modo IN ('PREVIA', 'CONFERIDO')),
  CONSTRAINT financeiro_abertura_conferencias_hash_check CHECK (atributos_hash ~ '^[0-9a-f]{64}$')
);
CREATE INDEX financeiro_abertura_conferencias_empresa_idx ON financeiro_abertura_conferencias (empresa_id, abertura_id);

CREATE TRIGGER financeiro_aberturas_121_somente_acrescimo BEFORE UPDATE OR DELETE ON financeiro_aberturas
  FOR EACH ROW EXECUTE FUNCTION kidmais_121_somente_acrescimo();
CREATE TRIGGER financeiro_abertura_conferencias_121_somente_acrescimo BEFORE UPDATE OR DELETE ON financeiro_abertura_conferencias
  FOR EACH ROW EXECUTE FUNCTION kidmais_121_somente_acrescimo();

COMMIT;
