-- Rollback da 110 (pesquisa de satisfação). NÃO EXECUTAR sem autorização explícita (docs/OPERACAO_AGENTES.md).
--
-- Rollback operacional recomendado: SATISFACAO_PESQUISA_ENABLED diferente de "true" e pausar as regras de pesquisa.
-- Este down existe para bancos descartáveis: RECUSA enquanto houver qualquer dado da pesquisa ou regra/execução com a
-- ação PESQUISA_SATISFACAO (evidências de envio, resposta e saída não são apagadas por rollback).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;

DO $$ BEGIN
  IF to_regclass('public.satisfacao_envios') IS NULL THEN RAISE EXCEPTION '110 ausente: nada a remover.'; END IF;
END $$;

LOCK TABLE marketing_automacao_regras, marketing_automacao_execucoes, satisfacao_envios, satisfacao_respostas, satisfacao_tarefas, satisfacao_entregas,
  satisfacao_saidas, satisfacao_capacidades, satisfacao_agregados_mensais, satisfacao_expurgos, satisfacao_email_simulado IN ACCESS EXCLUSIVE MODE;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM satisfacao_envios) OR EXISTS (SELECT 1 FROM satisfacao_saidas) OR EXISTS (SELECT 1 FROM satisfacao_capacidades)
     OR EXISTS (SELECT 1 FROM satisfacao_agregados_mensais) OR EXISTS (SELECT 1 FROM satisfacao_expurgos)
     OR EXISTS (SELECT 1 FROM marketing_automacao_regras WHERE acao = 'PESQUISA_SATISFACAO' OR cardinality(canais) > 0
                  OR template_lembrete_texto IS NOT NULL OR template_lembrete_provedor IS NOT NULL)
     OR EXISTS (SELECT 1 FROM marketing_automacao_execucoes WHERE acao = 'PESQUISA_SATISFACAO' OR estado = 'PESQUISA_CRIADA') THEN
    RAISE EXCEPTION '110: há dados da pesquisa; rollback recusado (use o rollback operacional).';
  END IF;
END $$;

DROP TABLE satisfacao_email_simulado, satisfacao_expurgos, satisfacao_agregados_mensais, satisfacao_capacidades, satisfacao_saidas,
  satisfacao_tarefas, satisfacao_entregas, satisfacao_respostas, satisfacao_envios;
DROP FUNCTION kidmais110_marco_contato(), kidmais110_entrega_guarda(), kidmais110_tarefa_guarda(), kidmais110_invariante_resposta(),
  kidmais110_resposta_guarda(), kidmais110_envio_guarda(), kidmais110_capacidade_guarda();

ALTER TABLE marketing_automacao_execucoes
  DROP CONSTRAINT marketing_exec_pesquisa_criada,
  DROP CONSTRAINT marketing_exec_pesquisa_estados,
  DROP CONSTRAINT marketing_exec_final,
  ADD CONSTRAINT marketing_exec_final CHECK ((estado IN ('TAREFA_CRIADA', 'ENTREGUE', 'SUPRIMIDA', 'CANCELADA')) = (concluida_em IS NOT NULL) OR estado IN ('ACEITA', 'FALHOU', 'INCERTA')),
  DROP CONSTRAINT marketing_exec_estado,
  ADD CONSTRAINT marketing_exec_estado CHECK (estado IN ('AGENDADA', 'PROCESSANDO', 'ENVIANDO', 'TAREFA_CRIADA', 'ACEITA', 'ENTREGUE', 'FALHOU', 'INCERTA', 'SUPRIMIDA', 'CANCELADA')),
  DROP CONSTRAINT marketing_exec_acao,
  ADD CONSTRAINT marketing_exec_acao CHECK (acao IN ('TAREFA_INTERNA', 'MENSAGEM_WHATSAPP'));

ALTER TABLE marketing_automacao_regras
  DROP CONSTRAINT marketing_regras_pesquisa_revisada,
  DROP CONSTRAINT marketing_regras_template_lembrete_provedor,
  DROP CONSTRAINT marketing_regras_template_lembrete,
  DROP CONSTRAINT marketing_regras_canais,
  DROP CONSTRAINT marketing_regras_pesquisa_pos_festa,
  DROP CONSTRAINT marketing_regras_acao,
  ADD CONSTRAINT marketing_regras_acao CHECK (acao IN ('TAREFA_INTERNA', 'MENSAGEM_WHATSAPP', 'SUGESTAO')),
  DROP COLUMN template_lembrete_provedor,
  DROP COLUMN template_lembrete_texto,
  DROP COLUMN canais;

-- Corpo original da 086 (sem PESQUISA_CRIADA).
CREATE OR REPLACE FUNCTION kidmais086_execucao_tenant() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_catalog, pg_temp AS $$
DECLARE dono uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION '086: execução de automação não é apagada; cancele.'; END IF;
  IF TG_OP = 'UPDATE' AND (NEW.empresa_id IS DISTINCT FROM OLD.empresa_id OR NEW.regra_id IS DISTINCT FROM OLD.regra_id
     OR NEW.cliente_id IS DISTINCT FROM OLD.cliente_id OR NEW.chave_idempotencia IS DISTINCT FROM OLD.chave_idempotencia
     OR NEW.alvo_id IS DISTINCT FROM OLD.alvo_id OR NEW.acao IS DISTINCT FROM OLD.acao) THEN
    RAISE EXCEPTION '086: identidade da execução é imutável.';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.estado IN ('TAREFA_CRIADA', 'ENTREGUE', 'SUPRIMIDA', 'CANCELADA') THEN
    RAISE EXCEPTION '086: execução concluída não muda (%).', OLD.estado;
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT empresa_id INTO dono FROM clientes WHERE id = NEW.cliente_id;
    IF dono IS DISTINCT FROM NEW.empresa_id THEN RAISE EXCEPTION '086: cliente da execução é de outra empresa.'; END IF;
    IF NEW.fechamento_id IS NOT NULL THEN
      SELECT empresa_id INTO dono FROM fechamentos WHERE id = NEW.fechamento_id;
      IF dono IS DISTINCT FROM NEW.empresa_id THEN RAISE EXCEPTION '086: negociação da execução é de outra empresa.'; END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;

COMMIT;
