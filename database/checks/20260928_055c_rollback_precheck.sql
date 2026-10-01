-- Rollback precheck da 055c: SOMENTE LEITURA. Diz se o down pode rodar.
-- O _down.sql repete estas condições DEPOIS de travar as tabelas (ACCESS EXCLUSIVE) e aborta sozinho;
-- este precheck serve para decidir antes e para registrar os números no relatório da janela.
-- Ordem de remoção: 055d → 055c → 055b → 055a.
DO $$
DECLARE
  documentos bigint;
BEGIN
  IF to_regclass('public.ia_documentos') IS NULL THEN
    RAISE EXCEPTION '055c rollback precheck: a 055c não está instalada.';
  END IF;
  IF to_regclass('public.ia_importacoes') IS NOT NULL THEN
    RAISE EXCEPTION '055c rollback precheck: ia_importacoes ainda existe; remova antes a migration dependente.';
  END IF;
  documentos := (SELECT count(*) FROM ia_documentos);
  RAISE NOTICE '055c rollback precheck: documentos = % (documento de cliente: retenção/descarte exige decisão humana (LGPD))', documentos;
  IF documentos > 0 THEN
    RAISE EXCEPTION '055c rollback precheck: remoção insegura (veja os avisos acima).';
  END IF;
END $$;
SELECT '055c rollback precheck OK' AS resultado;
