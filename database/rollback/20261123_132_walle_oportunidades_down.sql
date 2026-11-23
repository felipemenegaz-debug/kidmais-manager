-- Rollback da 132 (vínculo do Wall-e com o funil) — PREPARADO, NÃO EXECUTADO.
-- Apagar o vínculo perde a origem Wall-e dos cartões e a marca de anonimização (os contatos anonimizados continuam
-- anonimizados em marketing_contatos, mas voltariam às colunas do funil). Por isso só roda com a confirmação explícita na
-- mesma sessão:  SET kidmais.rollback_132 = 'descartar-vinculos';  Sem ela, recusa sem alterar nada.
-- r3: depois do primeiro vínculo gravado (inclusive anonimizado), recusa MESMO com a confirmação: o vínculo carrega a
-- origem e a prova da anonimização a pedido do titular, e apagá-lo devolveria o cartão às colunas. Daí em diante a
-- correção é para frente (nova migration), nunca este down.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;

DO $$
BEGIN
  IF current_setting('kidmais.rollback_132', true) IS DISTINCT FROM 'descartar-vinculos' THEN
    RAISE EXCEPTION '132 down: falta SET kidmais.rollback_132 = ''descartar-vinculos''; nada foi alterado';
  END IF;
  IF to_regclass('public.whatsapp_atendimento_oportunidades') IS NULL THEN
    RAISE EXCEPTION '132 down: a 132 não está aplicada';
  END IF;
  -- r4 (P1-1): a captura trava a conversa (FOR UPDATE) antes de gravar o vínculo. Travando as conversas e depois o vínculo,
  -- na mesma ordem, uma captura em curso termina antes desta checagem (e o vínculo dela a faz recusar) e nenhuma nova
  -- começa até o fim. ACCESS EXCLUSIVE já nas conversas evita subir de trava no DROP COLUMN. Sem trava em 5 s: aborta.
  LOCK TABLE whatsapp_atendimento_conversas IN ACCESS EXCLUSIVE MODE;
  LOCK TABLE whatsapp_atendimento_oportunidades IN ACCESS EXCLUSIVE MODE;
  IF EXISTS (SELECT 1 FROM whatsapp_atendimento_oportunidades) THEN
    RAISE EXCEPTION '132 down: já há vínculo do Wall-e gravado; rollback recusado (correção para frente); nada foi alterado';
  END IF;
END $$;

DROP INDEX walle_conversas_oportunidade_pendente_idx;
ALTER TABLE whatsapp_atendimento_conversas DROP COLUMN oportunidade_pendente_em;
DROP TABLE whatsapp_atendimento_oportunidades;
DROP FUNCTION kidmais132_oportunidade_guarda();

COMMIT;
