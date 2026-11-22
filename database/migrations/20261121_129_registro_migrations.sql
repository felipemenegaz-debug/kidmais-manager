-- 129: registro de tentativas de migration no banco (vault "Registro de migrations no banco 20261120", §3.1).
-- Substitui o marcador migration-<id>.json do disco (os discos dos webs saíram em 20/11). Só cria a tabela, a função e o gatilho
-- (D-REG-3). Aplicada SÓ pelo bootstrap de scripts/registro-migrations-banco.cjs, que insere a linha da própria 129 na mesma
-- transação, depois do postcheck. Nenhum GRANT: dono = papel que aplica.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;

CREATE TABLE public.operacao_migration_tentativas (
  id bigint GENERATED ALWAYS AS IDENTITY,
  tentativa uuid NOT NULL,
  ambiente text NOT NULL,
  migration text NOT NULL,
  backup text NOT NULL,
  situacao text NOT NULL,
  versao integer NOT NULL DEFAULT 1,
  detalhe jsonb NOT NULL DEFAULT '{}'::jsonb,
  iniciada_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  atualizada_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  arquivada_em timestamptz,
  arquivada_motivo text,
  substituida_por uuid,
  CONSTRAINT operacao_migration_tentativas_pk PRIMARY KEY (id),
  CONSTRAINT operacao_migration_tentativas_tentativa_uk UNIQUE (tentativa),
  CONSTRAINT operacao_migration_tentativas_ambiente_ck CHECK (ambiente IN ('production', 'staging')),
  CONSTRAINT operacao_migration_tentativas_migration_ck CHECK (migration ~ '^[0-9]{3}[a-z]?$'),
  CONSTRAINT operacao_migration_tentativas_backup_ck CHECK (backup ~ '^[A-Za-z0-9:._/ -]{6,120}$'),
  CONSTRAINT operacao_migration_tentativas_situacao_ck CHECK (situacao IN ('INICIADA', 'EM_ANDAMENTO', 'VERIFICACAO_PENDENTE', 'CONCLUIDA', 'FALHA')),
  CONSTRAINT operacao_migration_tentativas_versao_ck CHECK (versao >= 1),
  CONSTRAINT operacao_migration_tentativas_detalhe_ck CHECK (jsonb_typeof(detalhe) = 'object'),
  CONSTRAINT operacao_migration_tentativas_arquivada_ck CHECK ((arquivada_em IS NULL) = (arquivada_motivo IS NULL)
    AND (arquivada_motivo IS NULL OR char_length(arquivada_motivo) BETWEEN 10 AND 300)),
  CONSTRAINT operacao_migration_tentativas_substituida_ck CHECK (substituida_por IS NULL OR arquivada_em IS NOT NULL)
);

-- No máximo uma tentativa ativa por (ambiente, migration); arquivadas ficam como histórico.
CREATE UNIQUE INDEX operacao_migration_tentativas_ativa_uk ON public.operacao_migration_tentativas (ambiente, migration)
  WHERE arquivada_em IS NULL;

-- Linha CONCLUIDA é terminal e nada é apagado.
CREATE FUNCTION public.operacao_migration_tentativas_terminal() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'operacao_migration_tentativas: DELETE recusado';
  END IF;
  IF OLD.situacao = 'CONCLUIDA' THEN
    RAISE EXCEPTION 'operacao_migration_tentativas: linha CONCLUIDA e terminal';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER operacao_migration_tentativas_terminal
  BEFORE UPDATE OR DELETE ON public.operacao_migration_tentativas
  FOR EACH ROW EXECUTE FUNCTION public.operacao_migration_tentativas_terminal();

REVOKE ALL ON TABLE public.operacao_migration_tentativas FROM PUBLIC;
REVOKE ALL ON SEQUENCE public.operacao_migration_tentativas_id_seq FROM PUBLIC;
REVOKE ALL ON FUNCTION public.operacao_migration_tentativas_terminal() FROM PUBLIC;
COMMIT;
