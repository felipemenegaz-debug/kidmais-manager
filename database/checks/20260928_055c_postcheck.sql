-- Postcheck da 055c (Document Foundation): somente leitura. Tabelas, gatilhos ativos e funções sem SECURITY DEFINER,
-- com search_path fixo.
DO $$
DECLARE
  item text;
BEGIN
  FOREACH item IN ARRAY ARRAY['ia_documentos', 'ia_documento_originais', 'ia_extracoes', 'ia_evidencias'] LOOP
    IF to_regclass('public.' || item) IS NULL THEN
      RAISE EXCEPTION 'postcheck 055c: % ausente', item;
    END IF;
  END LOOP;
  FOREACH item IN ARRAY ARRAY['ia_documentos_055_guarda_trg', 'ia_documento_originais_055_imutavel_trg', 'ia_extracoes_055_imutavel_trg', 'ia_evidencias_055_imutavel_trg'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = item AND tgenabled = 'O' AND NOT tgisinternal) THEN
      RAISE EXCEPTION 'postcheck 055c: gatilho % ausente ou desligado', item;
    END IF;
  END LOOP;
  FOREACH item IN ARRAY ARRAY['kidmais_055_documento_guarda'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = item AND NOT p.prosecdef
         AND p.proconfig @> ARRAY['search_path=pg_catalog, pg_temp']
    ) THEN
      RAISE EXCEPTION 'postcheck 055c: função % ausente, SECURITY DEFINER ou sem search_path fixo', item;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ia_documento_originais_hash_check' AND convalidated) THEN
    RAISE EXCEPTION 'postcheck 055c: hash dos originais não conferido pelo banco';
  END IF;
END $$;
SELECT 'postcheck 055c OK' AS resultado;
