-- Rollback precheck da 058: SOMENTE LEITURA. Diz se o down pode rodar e registra os números da janela.
-- O _down.sql repete a condição DEPOIS de travar a tabela (ACCESS EXCLUSIVE) e aborta sozinho.
DO $$
DECLARE
  cadastradas bigint;
  ativas bigint;
BEGIN
  IF to_regclass('public.ia_skills') IS NULL THEN
    RAISE EXCEPTION '058 rollback precheck: a 058 não está instalada.';
  END IF;
  cadastradas := (SELECT count(*) FROM ia_skills);
  ativas := (SELECT count(*) FROM ia_skills WHERE status = 'ATIVA');
  RAISE NOTICE '058 rollback precheck: skills cadastradas = %, ativas = % (com cadastro: exporte ia_skills e confirme o descarte com SET LOCAL kidmais.rollback_058_descartar_skills = ''sim'' no down)', cadastradas, ativas;
END $$;
SELECT '058 rollback precheck OK' AS resultado;
