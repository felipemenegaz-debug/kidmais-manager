-- Rollback precheck da 055b: SOMENTE LEITURA. Diz se o down pode rodar.
-- O _down.sql repete estas condições DEPOIS de travar as tabelas (ACCESS EXCLUSIVE) e aborta sozinho;
-- este precheck serve para decidir antes e para registrar os números no relatório da janela.
-- Ordem de remoção: 055d → 055c → 055b → 055a.
DO $$
DECLARE
  operacoes_executadas bigint;
  rascunhos_validos bigint;
BEGIN
  IF to_regclass('public.ia_operacoes') IS NULL THEN
    RAISE EXCEPTION '055b rollback precheck: a 055b não está instalada.';
  END IF;
  operacoes_executadas := (SELECT count(*) FROM ia_operacoes WHERE estado = 'EXECUTADA');
  rascunhos_validos := (SELECT count(*) FROM ia_operacoes WHERE estado IN ('COLETANDO', 'AGUARDANDO_CONFIRMACAO') AND expira_em > now());
  RAISE NOTICE '055b rollback precheck: operacoes_executadas = % (operação executada liga mutação de negócio ao Human Gate)', operacoes_executadas;
  RAISE NOTICE '055b rollback precheck: rascunhos_validos = % (rascunho ainda válido: desligue as flags de ação e aguarde a expiração)', rascunhos_validos;
  IF operacoes_executadas > 0 OR rascunhos_validos > 0 THEN
    RAISE EXCEPTION '055b rollback precheck: remoção insegura (veja os avisos acima).';
  END IF;
END $$;
SELECT '055b rollback precheck OK' AS resultado;
