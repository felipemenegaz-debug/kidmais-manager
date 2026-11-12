-- 093: configuração da agenda por unidade (etapa 2a das decisões de Felipe em 22/10/2026).
-- Escopo = unidade agendável (062) ou, quando a empresa não tem unidade agendável, a própria empresa (unidade NULL).
-- Guarda: modo (horários fixos ou horário livre), capacidade (por horário ou por salão), limite de festas por dia,
-- intervalo mínimo entre festas, salões, dias da semana / capacidade / desativação de cada horário, o horário técnico
-- "Horário livre" e os salões permitidos de cada pacote.
-- ADITIVA: nenhuma função de conflito muda (019/061/062 e o manifesto da Festa ficam como estão). Capacidade, limite e
-- intervalo só passam a valer na etapa 2b; o filtro de dias e a desativação valem já no cálculo em TypeScript.
-- ORDEM: aplicar a 093 ANTES do código que lê estas tabelas (o código confere a presença e, sem ela, mantém a agenda
-- de hoje). Com a 093 aplicada e o código antigo no ar, nada muda (colunas com padrão neutro, tabelas vazias).
-- Executar somente após autorização própria do ambiente, precheck e backup operacional.
-- Rollback: database/rollback/20261022_093_agenda_configuracao_unidade_down.sql (recusado se houver configuração).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;
DO $$
BEGIN
  IF to_regclass('public.configuracao_agenda') IS NULL OR to_regclass('public.estabelecimentos') IS NULL
    OR to_regclass('public.pacotes') IS NULL OR to_regclass('public.usuarios_administrativos') IS NULL
    OR to_regprocedure('public.kidmais062_unidade_agendavel(uuid,uuid)') IS NULL
    OR to_regclass('public.agenda_escopo_config') IS NOT NULL OR to_regclass('public.agenda_saloes') IS NOT NULL
    OR EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
                AND table_name = 'configuracao_agenda' AND column_name = 'dias_semana') THEN
    RAISE EXCEPTION '093: precheck falhou (043/062 ausentes ou 093 anterior/parcial); nada alterado';
  END IF;
END $$;

CREATE TABLE agenda_escopo_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  estabelecimento_id uuid,
  modo text NOT NULL CHECK (modo IN ('FIXO', 'LIVRE')),
  capacidade_tipo text NOT NULL CHECK (capacidade_tipo IN ('POR_HORARIO', 'POR_SALAO')),
  limite_festas_dia smallint CHECK (limite_festas_dia IS NULL OR limite_festas_dia BETWEEN 1 AND 50),
  intervalo_minimo_minutos smallint NOT NULL DEFAULT 60 CHECK (intervalo_minimo_minutos BETWEEN 0 AND 480),
  configurado_por uuid NOT NULL REFERENCES usuarios_administrativos(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  configurado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  atualizado_por uuid REFERENCES usuarios_administrativos(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  atualizado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT agenda_escopo_config_estabelecimento_fk FOREIGN KEY (empresa_id, estabelecimento_id)
    REFERENCES estabelecimentos(empresa_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX agenda_escopo_config_escopo_uk ON agenda_escopo_config
  (empresa_id, coalesce(estabelecimento_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE TABLE agenda_saloes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  estabelecimento_id uuid,
  nome text NOT NULL CHECK (length(btrim(nome)) BETWEEN 1 AND 80),
  capacidade_convidados smallint CHECK (capacidade_convidados IS NULL OR capacidade_convidados > 0),
  ordem smallint NOT NULL DEFAULT 1 CHECK (ordem > 0),
  ativo boolean NOT NULL DEFAULT true,
  criado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT agenda_saloes_estabelecimento_fk FOREIGN KEY (empresa_id, estabelecimento_id)
    REFERENCES estabelecimentos(empresa_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT agenda_saloes_empresa_id_uk UNIQUE (empresa_id, id)
);
CREATE UNIQUE INDEX agenda_saloes_nome_uk ON agenda_saloes
  (empresa_id, coalesce(estabelecimento_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(btrim(nome))) WHERE ativo;

-- Horários: dias da semana (NULL = todos), festas ao mesmo tempo (capacidade por horário), desativação datada e o
-- horário técnico do modo livre (preço, disponibilidade e descontos por dia da semana; decisão de Felipe).
ALTER TABLE configuracao_agenda
  ADD COLUMN dias_semana smallint[]
    CHECK (dias_semana IS NULL OR (cardinality(dias_semana) BETWEEN 1 AND 7 AND dias_semana <@ ARRAY[1,2,3,4,5,6,7]::smallint[])),
  ADD COLUMN capacidade smallint NOT NULL DEFAULT 1 CHECK (capacidade BETWEEN 1 AND 20),
  ADD COLUMN desativado_a_partir_de date,
  ADD COLUMN horario_livre boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT configuracao_agenda_093_livre_escopo_check CHECK (NOT horario_livre OR empresa_id IS NOT NULL);

CREATE TABLE configuracao_agenda_saloes (
  configuracao_agenda_id uuid NOT NULL REFERENCES configuracao_agenda(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  salao_id uuid NOT NULL REFERENCES agenda_saloes(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  PRIMARY KEY (configuracao_agenda_id, salao_id)
);

CREATE TABLE pacote_saloes (
  pacote_id uuid NOT NULL REFERENCES pacotes(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  salao_id uuid NOT NULL REFERENCES agenda_saloes(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  PRIMARY KEY (pacote_id, salao_id)
);

-- Isolamento: salão, horário e pacote ligados só dentro da mesma empresa.
CREATE FUNCTION kidmais093_mesma_empresa() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  dona_salao uuid;
  dona_outro uuid;
BEGIN
  SELECT empresa_id INTO dona_salao FROM agenda_saloes WHERE id = NEW.salao_id;
  IF TG_TABLE_NAME = 'configuracao_agenda_saloes' THEN
    SELECT empresa_id INTO dona_outro FROM configuracao_agenda WHERE id = NEW.configuracao_agenda_id;
  ELSE
    SELECT empresa_id INTO dona_outro FROM pacotes WHERE id = NEW.pacote_id;
  END IF;
  IF dona_salao IS NULL OR dona_outro IS DISTINCT FROM dona_salao THEN
    RAISE EXCEPTION '093: salão de outra empresa' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER configuracao_agenda_saloes_093_empresa_trg BEFORE INSERT OR UPDATE ON configuracao_agenda_saloes
  FOR EACH ROW EXECUTE FUNCTION kidmais093_mesma_empresa();
CREATE TRIGGER pacote_saloes_093_empresa_trg BEFORE INSERT OR UPDATE ON pacote_saloes
  FOR EACH ROW EXECUTE FUNCTION kidmais093_mesma_empresa();

COMMIT;
