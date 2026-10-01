-- Postcheck da 055d (importação histórica): somente leitura. Tabelas, gatilhos ativos e funções sem SECURITY DEFINER,
-- com search_path fixo.
DO $$
DECLARE
  item text;
BEGIN
  FOREACH item IN ARRAY ARRAY['ia_importacoes'] LOOP
    IF to_regclass('public.' || item) IS NULL THEN
      RAISE EXCEPTION 'postcheck 055d: % ausente', item;
    END IF;
  END LOOP;
  FOREACH item IN ARRAY ARRAY['ia_importacoes_055_guarda_trg'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = item AND tgenabled = 'O' AND NOT tgisinternal) THEN
      RAISE EXCEPTION 'postcheck 055d: gatilho % ausente ou desligado', item;
    END IF;
  END LOOP;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public' AND tablename = 'ia_importacoes' AND indexname = 'ia_importacoes_documento_ativa_uk'
       AND indexdef LIKE 'CREATE UNIQUE INDEX%' AND indexdef LIKE '%DESCARTADA%'
  ) THEN
    RAISE EXCEPTION 'postcheck 055d: índice único parcial ia_importacoes_documento_ativa_uk ausente';
  END IF;
  FOREACH item IN ARRAY ARRAY['kidmais_055_importacao_guarda'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = item AND NOT p.prosecdef
         AND p.proconfig @> ARRAY['search_path=pg_catalog, pg_temp']
    ) THEN
      RAISE EXCEPTION 'postcheck 055d: função % ausente, SECURITY DEFINER ou sem search_path fixo', item;
    END IF;
  END LOOP;
END $$;
SELECT 'postcheck 055d OK' AS resultado;
