-- Postcheck da 058 (skills de empresa/unidade): somente leitura. Tabela, gatilhos ativos, funções sem SECURITY DEFINER
-- com search_path fixo, e as garantias de escopo, coerência da definição e unicidade.
DO $$
DECLARE
  item text;
BEGIN
  IF to_regclass('public.ia_skills') IS NULL THEN
    RAISE EXCEPTION 'postcheck 058: ia_skills ausente';
  END IF;
  FOREACH item IN ARRAY ARRAY['ia_skills_058_guarda_trg', 'ia_skills_058_truncate_trg'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = item AND tgenabled = 'O' AND NOT tgisinternal) THEN
      RAISE EXCEPTION 'postcheck 058: gatilho % ausente ou desligado', item;
    END IF;
  END LOOP;
  FOREACH item IN ARRAY ARRAY['kidmais_058_skill_guarda', 'kidmais_058_bloquear_truncate', 'kidmais_058_metadados_ok', 'kidmais_058_conteudo_ok', 'kidmais_058_chaves_exatas', 'kidmais_058_lista_textos_ok', 'kidmais_058_texto_ok', 'kidmais_058_trim_js'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = item AND NOT p.prosecdef
         AND p.proconfig @> ARRAY['search_path=pg_catalog, pg_temp']
    ) THEN
      RAISE EXCEPTION 'postcheck 058: função % ausente, SECURITY DEFINER ou sem search_path fixo', item;
    END IF;
  END LOOP;
  FOREACH item IN ARRAY ARRAY['ia_skills_058_escopo_check', 'ia_skills_058_estabelecimento_fk', 'ia_skills_058_definicao_chaves_check',
                               'ia_skills_058_definicao_tipos_check', 'ia_skills_058_definicao_valores_check', 'ia_skills_058_definicao_limites_check', 'ia_skills_058_conteudo_check', 'ia_skills_058_definicao_check', 'ia_skills_058_versao_uk'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = item AND convalidated) THEN
      RAISE EXCEPTION 'postcheck 058: restrição % ausente ou não validada', item;
    END IF;
  END LOOP;
  IF to_regclass('public.ia_skills_058_uma_ativa_uk') IS NULL THEN
    RAISE EXCEPTION 'postcheck 058: índice de uma versão ATIVA por skill ausente';
  END IF;
END $$;
SELECT 'postcheck 058 OK' AS resultado;
