-- Verificação pós-rollback da 055b: SOMENTE LEITURA. Nenhum objeto da 055b sobrou e o Core continua intacto.
DO $$
DECLARE
  item text;
BEGIN
  FOREACH item IN ARRAY ARRAY['ia_operacoes', 'ia_operacoes_resumo'] LOOP
    IF to_regclass('public.' || item) IS NOT NULL THEN
      RAISE EXCEPTION '055b pós-rollback: % ainda existe', item;
    END IF;
  END LOOP;
  FOREACH item IN ARRAY ARRAY['kidmais_055_operacao_guarda'] LOOP
    IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = item) THEN
      RAISE EXCEPTION '055b pós-rollback: função % ainda existe', item;
    END IF;
  END LOOP;
  FOREACH item IN ARRAY ARRAY['empresas', 'usuarios_administrativos', 'clientes', 'fechamentos', 'contratos', 'pacotes'] LOOP
    IF to_regclass('public.' || item) IS NULL THEN
      RAISE EXCEPTION '055b pós-rollback: tabela do Core % ausente', item;
    END IF;
  END LOOP;
END $$;
SELECT '055b pós-rollback OK' AS resultado;
