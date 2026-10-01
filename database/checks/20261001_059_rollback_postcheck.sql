-- Verificação pós-rollback da 059: SOMENTE LEITURA. Nenhum objeto da 059 sobrou e o Core continua intacto.
DO $$
DECLARE
  item text;
BEGIN
  IF to_regclass('public.operacional_parametros_consumo') IS NOT NULL THEN
    RAISE EXCEPTION '059 pós-rollback: operacional_parametros_consumo ainda existe';
  END IF;
  FOREACH item IN ARRAY ARRAY['kidmais_059_parametro_guarda', 'kidmais_059_bloquear_truncate'] LOOP
    IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = item) THEN
      RAISE EXCEPTION '059 pós-rollback: função % ainda existe', item;
    END IF;
  END LOOP;
  FOREACH item IN ARRAY ARRAY['empresas', 'usuarios_administrativos'] LOOP
    IF to_regclass('public.' || item) IS NULL THEN
      RAISE EXCEPTION '059 pós-rollback: tabela do Core % ausente', item;
    END IF;
  END LOOP;
END $$;
SELECT '059 pós-rollback OK' AS resultado;
