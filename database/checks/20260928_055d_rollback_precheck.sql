-- Rollback precheck da 055d: SOMENTE LEITURA. Diz se o down pode rodar.
-- O _down.sql repete estas condições DEPOIS de travar as tabelas (ACCESS EXCLUSIVE) e aborta sozinho;
-- este precheck serve para decidir antes e para registrar os números no relatório da janela.
-- Ordem de remoção: 055d → 055c → 055b → 055a.
DO $$
DECLARE
  importacoes bigint;
BEGIN
  IF to_regclass('public.ia_importacoes') IS NULL THEN
    RAISE EXCEPTION '055d rollback precheck: a 055d não está instalada.';
  END IF;
  importacoes := (SELECT count(*) FROM ia_importacoes);
  RAISE NOTICE '055d rollback precheck: importacoes = % (importação registrada (em revisão, importada ou descartada))', importacoes;
  IF importacoes > 0 THEN
    RAISE EXCEPTION '055d rollback precheck: remoção insegura (veja os avisos acima).';
  END IF;
END $$;
SELECT '055d rollback precheck OK' AS resultado;
