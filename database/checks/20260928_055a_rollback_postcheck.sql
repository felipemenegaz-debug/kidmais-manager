-- Verificação pós-rollback da 055a: SOMENTE LEITURA. Nenhum objeto da 055a sobrou e o Core continua intacto.
DO $$
DECLARE
  item text;
BEGIN
  FOREACH item IN ARRAY ARRAY['ia_orcamento_reservas', 'ia_uso_modelo', 'ia_uso_diario'] LOOP
    IF to_regclass('public.' || item) IS NOT NULL THEN
      RAISE EXCEPTION '055a pós-rollback: % ainda existe', item;
    END IF;
  END LOOP;
  FOREACH item IN ARRAY ARRAY['kidmais_055_somente_insercao', 'kidmais_055a_reserva_guarda'] LOOP
    IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = item) THEN
      RAISE EXCEPTION '055a pós-rollback: função % ainda existe', item;
    END IF;
  END LOOP;
  FOREACH item IN ARRAY ARRAY['empresas', 'usuarios_administrativos', 'clientes', 'fechamentos', 'contratos', 'pacotes'] LOOP
    IF to_regclass('public.' || item) IS NULL THEN
      RAISE EXCEPTION '055a pós-rollback: tabela do Core % ausente', item;
    END IF;
  END LOOP;
END $$;
SELECT '055a pós-rollback OK' AS resultado;
