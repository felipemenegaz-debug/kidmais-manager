-- Postcheck da 055a (uso de modelos e reservas de orçamento): somente leitura. Tabelas, gatilhos ativos e funções sem SECURITY DEFINER,
-- com search_path fixo.
DO $$
DECLARE
  item text;
BEGIN
  FOREACH item IN ARRAY ARRAY['ia_orcamento_reservas', 'ia_uso_modelo', 'ia_uso_diario'] LOOP
    IF to_regclass('public.' || item) IS NULL THEN
      RAISE EXCEPTION 'postcheck 055a: % ausente', item;
    END IF;
  END LOOP;
  FOREACH item IN ARRAY ARRAY['ia_orcamento_reservas_055a_guarda_trg', 'ia_uso_modelo_055_imutavel_trg'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = item AND tgenabled = 'O' AND NOT tgisinternal) THEN
      RAISE EXCEPTION 'postcheck 055a: gatilho % ausente ou desligado', item;
    END IF;
  END LOOP;
  FOREACH item IN ARRAY ARRAY['kidmais_055_somente_insercao', 'kidmais_055a_reserva_guarda'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = item AND NOT p.prosecdef
         AND p.proconfig @> ARRAY['search_path=pg_catalog, pg_temp']
    ) THEN
      RAISE EXCEPTION 'postcheck 055a: função % ausente, SECURITY DEFINER ou sem search_path fixo', item;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ia_uso_modelo_tokens_check' AND convalidated) THEN
    RAISE EXCEPTION 'postcheck 055a: uso desconhecido (tokens NULL) sem checagem de consistência';
  END IF;
END $$;
SELECT 'postcheck 055a OK' AS resultado;
