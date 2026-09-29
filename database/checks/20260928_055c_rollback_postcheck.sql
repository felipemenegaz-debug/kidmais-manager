-- Verificação pós-rollback da 055c: SOMENTE LEITURA. Nenhum objeto da 055c sobrou e o Core continua intacto.
DO $$
DECLARE
  item text;
BEGIN
  FOREACH item IN ARRAY ARRAY['ia_documentos', 'ia_documento_originais', 'ia_extracoes', 'ia_evidencias'] LOOP
    IF to_regclass('public.' || item) IS NOT NULL THEN
      RAISE EXCEPTION '055c pós-rollback: % ainda existe', item;
    END IF;
  END LOOP;
  FOREACH item IN ARRAY ARRAY['kidmais_055_documento_guarda'] LOOP
    IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = item) THEN
      RAISE EXCEPTION '055c pós-rollback: função % ainda existe', item;
    END IF;
  END LOOP;
  FOREACH item IN ARRAY ARRAY['empresas', 'usuarios_administrativos', 'clientes', 'fechamentos', 'contratos', 'pacotes'] LOOP
    IF to_regclass('public.' || item) IS NULL THEN
      RAISE EXCEPTION '055c pós-rollback: tabela do Core % ausente', item;
    END IF;
  END LOOP;
END $$;
SELECT '055c pós-rollback OK' AS resultado;
