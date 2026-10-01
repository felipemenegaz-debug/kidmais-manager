-- Rollback da 059. NÃO EXECUTAR sem autorização explícita (docs/OPERACAO_AGENTES.md).
-- Antes: AI_OPERACIONAL_ENABLED desligada. O rollback de código/flag NÃO exige este script: sem a flag a IA não lê nem
-- grava parâmetros, e a tabela pode ficar (nada é apagado). Este down só serve para remover a estrutura.
--
-- Fail closed, numa transação só:
--   1. lock_timeout curto: se a aplicação ainda segura a tabela, aborta em vez de enfileirar.
--   2. trava ACCESS EXCLUSIVE antes de conferir: nenhuma versão nova entra depois da checagem.
--   3. com parâmetros gravados, exige decisão explícita de descarte
--      (SET LOCAL kidmais.rollback_059_descartar_parametros = 'sim'), depois de exportar a tabela.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$ BEGIN
  IF to_regclass('public.operacional_parametros_consumo') IS NULL THEN
    RAISE EXCEPTION '059 ausente: nada a remover.';
  END IF;
END $$;

LOCK TABLE operacional_parametros_consumo IN ACCESS EXCLUSIVE MODE;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM operacional_parametros_consumo) AND COALESCE(current_setting('kidmais.rollback_059_descartar_parametros', true), '') <> 'sim' THEN
    RAISE EXCEPTION 'Rollback da 059 recusado: há parâmetros gravados. Exporte operacional_parametros_consumo e confirme o descarte com SET LOCAL kidmais.rollback_059_descartar_parametros = ''sim''.';
  END IF;
END $$;

DROP TABLE operacional_parametros_consumo;
DROP FUNCTION kidmais_059_parametro_guarda();
DROP FUNCTION kidmais_059_bloquear_truncate();

COMMIT;
