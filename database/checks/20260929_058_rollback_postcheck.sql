-- Verificação pós-rollback da 058: SOMENTE LEITURA. Nenhum objeto da 058 sobrou e o Core continua intacto.
DO $$
DECLARE
  item text;
BEGIN
  IF to_regclass('public.ia_skills') IS NOT NULL THEN
    RAISE EXCEPTION '058 pós-rollback: ia_skills ainda existe';
  END IF;
  FOREACH item IN ARRAY ARRAY['kidmais_058_skill_guarda', 'kidmais_058_bloquear_truncate'] LOOP
    IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = item) THEN
      RAISE EXCEPTION '058 pós-rollback: função % ainda existe', item;
    END IF;
  END LOOP;
  FOREACH item IN ARRAY ARRAY['empresas', 'estabelecimentos', 'usuarios_administrativos'] LOOP
    IF to_regclass('public.' || item) IS NULL THEN
      RAISE EXCEPTION '058 pós-rollback: tabela do Core % ausente', item;
    END IF;
  END LOOP;
END $$;
SELECT '058 pós-rollback OK' AS resultado;
