-- Postcheck da 055b (Human Gate): somente leitura. Tabelas, gatilhos ativos e funções sem SECURITY DEFINER,
-- com search_path fixo.
DO $$
DECLARE
  item text;
BEGIN
  FOREACH item IN ARRAY ARRAY['ia_operacoes', 'ia_operacoes_resumo'] LOOP
    IF to_regclass('public.' || item) IS NULL THEN
      RAISE EXCEPTION 'postcheck 055b: % ausente', item;
    END IF;
  END LOOP;
  FOREACH item IN ARRAY ARRAY['ia_operacoes_055_guarda_trg'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = item AND tgenabled = 'O' AND NOT tgisinternal) THEN
      RAISE EXCEPTION 'postcheck 055b: gatilho % ausente ou desligado', item;
    END IF;
  END LOOP;
  FOREACH item IN ARRAY ARRAY['kidmais_055_operacao_guarda'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = item AND NOT p.prosecdef
         AND p.proconfig @> ARRAY['search_path=pg_catalog, pg_temp']
    ) THEN
      RAISE EXCEPTION 'postcheck 055b: função % ausente, SECURITY DEFINER ou sem search_path fixo', item;
    END IF;
  END LOOP;
END $$;
SELECT 'postcheck 055b OK' AS resultado;
