-- Postcheck da 059 (parâmetros de consumo por empresa): somente leitura. Tabela, gatilhos ativos, funções sem SECURITY
-- DEFINER com search_path fixo, restrições validadas e o índice de uma versão vigente por (empresa, categoria).
DO $$
DECLARE
  item text;
BEGIN
  IF to_regclass('public.operacional_parametros_consumo') IS NULL THEN
    RAISE EXCEPTION 'postcheck 059: operacional_parametros_consumo ausente';
  END IF;
  FOREACH item IN ARRAY ARRAY['operacional_059_guarda_trg', 'operacional_059_truncate_trg'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = item AND tgenabled = 'O' AND NOT tgisinternal) THEN
      RAISE EXCEPTION 'postcheck 059: gatilho % ausente ou desligado', item;
    END IF;
  END LOOP;
  FOREACH item IN ARRAY ARRAY['kidmais_059_parametro_guarda', 'kidmais_059_bloquear_truncate'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = item AND NOT p.prosecdef
         AND p.proconfig @> ARRAY['search_path=pg_catalog, pg_temp']
    ) THEN
      RAISE EXCEPTION 'postcheck 059: função % ausente, SECURITY DEFINER ou sem search_path fixo', item;
    END IF;
  END LOOP;
  FOREACH item IN ARRAY ARRAY['operacional_059_categoria_check', 'operacional_059_vigencia_check', 'operacional_059_versao_uk'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = item AND convalidated) THEN
      RAISE EXCEPTION 'postcheck 059: restrição % ausente ou não validada', item;
    END IF;
  END LOOP;
  IF to_regclass('public.operacional_059_uma_vigente_uk') IS NULL THEN
    RAISE EXCEPTION 'postcheck 059: índice de uma versão vigente por categoria ausente';
  END IF;
END $$;
SELECT 'postcheck 059 OK' AS resultado;
