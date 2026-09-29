-- Rollback da 055b. NÃO EXECUTAR sem autorização explícita (docs/OPERACAO_AGENTES.md).
-- Procedimento completo em docs/INTELIGENCIA_PRODUCAO_V1.md (flags → drenar → precheck → down → verificação).
--
-- Fail closed, numa transação só: lock_timeout curto, trava ACCESS EXCLUSIVE ANTES de conferir e
-- reconferência sob a trava. Uma confirmação que chegue durante o rollback espera a trava e, depois,
-- encontra a tabela removida (falha segura na rota); uma que já tenha gravado é vista pela reconferência.
-- Recusa: operação EXECUTADA (liga a mutação de negócio ao Human Gate) ou rascunho ainda válido.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$ BEGIN
  IF to_regclass('public.ia_operacoes') IS NULL THEN
    RAISE EXCEPTION '055b ausente: nada a remover.';
  END IF;
END $$;

LOCK TABLE ia_operacoes IN ACCESS EXCLUSIVE MODE;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM ia_operacoes WHERE estado = 'EXECUTADA') THEN
    RAISE EXCEPTION 'Rollback da 055b recusado: há operações executadas (registro do Human Gate de mutações de negócio).';
  END IF;
  IF EXISTS (SELECT 1 FROM ia_operacoes WHERE estado IN ('COLETANDO', 'AGUARDANDO_CONFIRMACAO') AND expira_em > now()) THEN
    RAISE EXCEPTION 'Rollback da 055b recusado: há rascunho ainda válido. Desligue AI_ADMIN_ACTIONS_ENABLED e AI_CONTRACT_IMPORT_ENABLED e aguarde a expiração.';
  END IF;
END $$;

DROP VIEW ia_operacoes_resumo;
DROP TABLE ia_operacoes;
DROP FUNCTION kidmais_055_operacao_guarda();

COMMIT;
