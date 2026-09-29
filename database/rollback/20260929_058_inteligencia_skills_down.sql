-- Rollback da 058. NÃO EXECUTAR sem autorização explícita (docs/OPERACAO_AGENTES.md).
-- Antes: AI_SKILLS_EMPRESA_ENABLED desligada (a IA volta a usar só as skills da plataforma).
--
-- Fail closed, numa transação só:
--   1. lock_timeout curto: se a aplicação ainda segura a tabela, aborta em vez de enfileirar.
--   2. trava ACCESS EXCLUSIVE antes de conferir: nenhuma versão nova entra depois da checagem.
--   3. com skills cadastradas, exige decisão explícita de descarte
--      (SET LOCAL kidmais.rollback_058_descartar_skills = 'sim'), depois de exportar a tabela.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$ BEGIN
  IF to_regclass('public.ia_skills') IS NULL THEN
    RAISE EXCEPTION '058 ausente: nada a remover.';
  END IF;
END $$;

LOCK TABLE ia_skills IN ACCESS EXCLUSIVE MODE;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM ia_skills) AND COALESCE(current_setting('kidmais.rollback_058_descartar_skills', true), '') <> 'sim' THEN
    RAISE EXCEPTION 'Rollback da 058 recusado: há skills cadastradas. Exporte ia_skills e confirme o descarte com SET LOCAL kidmais.rollback_058_descartar_skills = ''sim''.';
  END IF;
END $$;

DROP TABLE ia_skills;
DROP FUNCTION kidmais_058_skill_guarda();
DROP FUNCTION kidmais_058_bloquear_truncate();
DROP FUNCTION kidmais_058_metadados_ok(jsonb);
DROP FUNCTION kidmais_058_conteudo_ok(jsonb);
DROP FUNCTION kidmais_058_chaves_exatas(jsonb, text[]);
DROP FUNCTION kidmais_058_lista_textos_ok(jsonb, int, int);
DROP FUNCTION kidmais_058_texto_ok(jsonb, int);
DROP FUNCTION kidmais_058_trim_js(text);

COMMIT;
