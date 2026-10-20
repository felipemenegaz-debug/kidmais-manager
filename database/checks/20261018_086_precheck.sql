-- Precheck da 086 (automações de Marketing): somente leitura. Exige a 085 e confirma que nada da 086 existe.
BEGIN TRANSACTION READ ONLY;
SELECT
  to_regclass('public.marketing_campanhas') IS NOT NULL AND to_regclass('public.marketing_atribuicoes') IS NOT NULL AS tem_085,
  to_regprocedure('public.kidmais085_somente_insercao()') IS NOT NULL AS tem_funcao_append_only,
  to_regclass('public.marketing_automacao_regras') IS NULL AND to_regclass('public.marketing_automacao_execucoes') IS NULL
    AND to_regclass('public.marketing_contato_preferencias') IS NULL AND to_regclass('public.marketing_tarefas') IS NULL
    AND to_regclass('public.marketing_contato_autorizacoes') IS NULL AND to_regprocedure('public.kidmais086_destino(text)') IS NULL
    AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'marketing_aut_numero_saiu') AS automacoes_ausentes;
ROLLBACK;
