-- Rollback da 084 (automações de Marketing). NÃO EXECUTAR sem autorização explícita (docs/OPERACAO_AGENTES.md).
--
-- Rollback operacional recomendado: MARKETING_AUTOMACOES_ENABLED diferente de "true" (nada é processado) e pausar as
-- regras. O schema da 084 é aditivo e pode ficar.
-- Este down existe só para bancos descartáveis: RECUSA enquanto houver execução, tarefa, preferência ou registro no
-- transporte simulado (evidências de envio e de consentimento/descadastro não são apagadas por rollback).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$ BEGIN
  IF to_regclass('public.marketing_automacao_regras') IS NULL THEN RAISE EXCEPTION '084 ausente: nada a remover.'; END IF;
END $$;

LOCK TABLE marketing_automacao_execucoes, marketing_tarefas, marketing_contato_preferencias, marketing_contato_autorizacoes, marketing_transporte_simulado IN ACCESS EXCLUSIVE MODE;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM marketing_automacao_execucoes) OR EXISTS (SELECT 1 FROM marketing_tarefas)
     OR EXISTS (SELECT 1 FROM marketing_contato_preferencias) OR EXISTS (SELECT 1 FROM marketing_contato_preferencias_eventos)
     OR EXISTS (SELECT 1 FROM marketing_contato_autorizacoes)
     OR EXISTS (SELECT 1 FROM marketing_transporte_simulado) THEN
    RAISE EXCEPTION '084: há execuções, tarefas, preferências ou envios simulados; rollback recusado (use o rollback operacional).';
  END IF;
END $$;

DROP TRIGGER marketing_aut_numero_saiu ON clientes;
DROP FUNCTION kidmais084_numero_saiu_do_cadastro();
DROP FUNCTION kidmais084_destino(text);
DROP TABLE marketing_transporte_simulado;
DROP TABLE marketing_tarefas;
DROP TABLE marketing_contato_autorizacoes;
DROP TABLE marketing_contato_preferencias;
DROP TABLE marketing_contato_preferencias_eventos;
DROP TABLE marketing_automacao_eventos;
DROP TABLE marketing_automacao_execucoes;
DROP TABLE marketing_automacao_regras;
DROP FUNCTION kidmais084_autorizacao_controle();
DROP FUNCTION kidmais084_preferencia_tenant();
DROP FUNCTION kidmais084_execucao_tenant();

COMMIT;
