-- Rollback da 055d. NÃO EXECUTAR sem autorização explícita (docs/OPERACAO_AGENTES.md).
-- Procedimento completo em docs/INTELIGENCIA_PRODUCAO_V1.md (flags → drenar → precheck → down → verificação).
--
-- Fail closed, numa transação só: lock_timeout curto, trava ACCESS EXCLUSIVE ANTES de conferir e
-- reconferência sob a trava. Recusa: qualquer importação registrada (em revisão, importada ou descartada):
-- a importada é a origem de um cliente/contrato histórico; a em revisão é trabalho do operador.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$ BEGIN
  IF to_regclass('public.ia_importacoes') IS NULL THEN
    RAISE EXCEPTION '055d ausente: nada a remover.';
  END IF;
END $$;

LOCK TABLE ia_importacoes IN ACCESS EXCLUSIVE MODE;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM ia_importacoes) THEN
    RAISE EXCEPTION 'Rollback da 055d recusado: há importações registradas.';
  END IF;
END $$;

DROP TABLE ia_importacoes;
DROP FUNCTION kidmais_055_importacao_guarda();

COMMIT;
