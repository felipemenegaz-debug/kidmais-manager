-- Rollback precheck da 055a: SOMENTE LEITURA. Diz se o down pode rodar.
-- O _down.sql repete estas condições DEPOIS de travar as tabelas (ACCESS EXCLUSIVE) e aborta sozinho;
-- este precheck serve para decidir antes e para registrar os números no relatório da janela.
-- Ordem de remoção: 055d → 055c → 055b → 055a.
DO $$
DECLARE
  reservas_abertas bigint;
  usos_registrados bigint;
  reservas_historico bigint;
BEGIN
  IF to_regclass('public.ia_orcamento_reservas') IS NULL THEN
    RAISE EXCEPTION '055a rollback precheck: a 055a não está instalada.';
  END IF;
  IF to_regclass('public.ia_documentos') IS NOT NULL THEN
    RAISE EXCEPTION '055a rollback precheck: ia_documentos ainda existe; remova antes a migration dependente.';
  END IF;
  reservas_abertas := (SELECT count(*) FROM ia_orcamento_reservas WHERE estado = 'ABERTA');
  usos_registrados := (SELECT count(*) FROM ia_uso_modelo);
  reservas_historico := (SELECT count(*) FROM ia_orcamento_reservas WHERE estado <> 'ABERTA');
  RAISE NOTICE '055a rollback precheck: reservas_abertas = % (reserva aberta (chamada em andamento): desligue as flags e drene)', reservas_abertas;
  RAISE NOTICE '055a rollback precheck: usos_registrados = % (histórico de uso: exporte ia_uso_diario e confirme o descarte com SET LOCAL kidmais.rollback_055a_descartar_uso = ''sim'' no down)', usos_registrados;
  RAISE NOTICE '055a rollback precheck: reservas_historico = % (reservas encerradas ou órfãs também são histórico: mesmo descarte explícito)', reservas_historico;
  IF reservas_abertas > 0 THEN
    RAISE EXCEPTION '055a rollback precheck: remoção insegura (veja os avisos acima).';
  END IF;
END $$;
SELECT '055a rollback precheck OK' AS resultado;
