-- Rollback da 093. Recusado se alguma unidade já foi configurada ou se algum horário usa as colunas novas: o rollback
-- não apaga configuração do buffet. Horários criados pela tela continuam em configuracao_agenda (são linhas da 062).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;
DO $$
BEGIN
  IF to_regclass('public.agenda_escopo_config') IS NULL THEN
    RAISE EXCEPTION '093 rollback: a 093 não está aplicada; nada alterado';
  END IF;
  IF EXISTS (SELECT 1 FROM agenda_escopo_config) OR EXISTS (SELECT 1 FROM agenda_saloes)
    OR EXISTS (SELECT 1 FROM configuracao_agenda WHERE dias_semana IS NOT NULL OR capacidade <> 1
                OR desativado_a_partir_de IS NOT NULL OR horario_livre) THEN
    RAISE EXCEPTION '093 rollback: há configuração de agenda gravada; nada alterado';
  END IF;
END $$;
DROP TABLE pacote_saloes;
DROP TABLE configuracao_agenda_saloes;
DROP FUNCTION kidmais093_mesma_empresa();
ALTER TABLE configuracao_agenda
  DROP CONSTRAINT configuracao_agenda_093_livre_escopo_check,
  DROP COLUMN horario_livre,
  DROP COLUMN desativado_a_partir_de,
  DROP COLUMN capacidade,
  DROP COLUMN dias_semana;
DROP TABLE agenda_saloes;
DROP TABLE agenda_escopo_config;
COMMIT;
