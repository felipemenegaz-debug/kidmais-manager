-- Rollback da 132 (vínculo do Wall-e com o funil) — PREPARADO, NÃO EXECUTADO.
-- Apagar o vínculo perde a origem Wall-e dos cartões e a marca de anonimização (os contatos anonimizados continuam
-- anonimizados em marketing_contatos, mas voltariam às colunas do funil). Por isso só roda com a confirmação explícita na
-- mesma sessão:  SET kidmais.rollback_132 = 'descartar-vinculos';  Sem ela, recusa sem alterar nada.
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
END $$;

DROP INDEX walle_conversas_oportunidade_pendente_idx;
ALTER TABLE whatsapp_atendimento_conversas DROP COLUMN oportunidade_pendente_em;
DROP TABLE whatsapp_atendimento_oportunidades;
DROP FUNCTION kidmais132_oportunidade_guarda();

COMMIT;
