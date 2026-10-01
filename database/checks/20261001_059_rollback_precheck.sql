-- Rollback precheck da 059: SOMENTE LEITURA. Diz se o down pode rodar e registra os números da janela.
-- O _down.sql repete a condição DEPOIS de travar a tabela (ACCESS EXCLUSIVE) e aborta sozinho.
DO $$
DECLARE
  versoes bigint;
  vigentes bigint;
BEGIN
  IF to_regclass('public.operacional_parametros_consumo') IS NULL THEN
    RAISE EXCEPTION '059 rollback precheck: a 059 não está instalada.';
  END IF;
  versoes := (SELECT count(*) FROM operacional_parametros_consumo);
  vigentes := (SELECT count(*) FROM operacional_parametros_consumo WHERE substituida_em IS NULL);
  RAISE NOTICE '059 rollback precheck: versões gravadas = %, vigentes = % (com dados: exporte a tabela e confirme o descarte com SET LOCAL kidmais.rollback_059_descartar_parametros = ''sim'' no down)', versoes, vigentes;
END $$;
SELECT '059 rollback precheck OK' AS resultado;
