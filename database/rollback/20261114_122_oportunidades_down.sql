-- Só com autorização específica; nunca apagar histórico comercial.
BEGIN;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM oportunidades_acoes) OR EXISTS(SELECT 1 FROM oportunidades_marcos) OR EXISTS(SELECT 1 FROM oportunidades_resumos)
 OR EXISTS(SELECT 1 FROM marketing_contatos WHERE perdida_em IS NOT NULL OR responsavel_id IS NOT NULL)
 OR EXISTS(SELECT 1 FROM fechamentos WHERE perdida_em IS NOT NULL OR confirmada_em IS NOT NULL) THEN RAISE EXCEPTION '122 tem evidência: preservar dados e reverter somente código'; END IF;
END $$;
DROP TRIGGER oportunidades_etapa ON fechamentos;
DROP TRIGGER oportunidades_confirmada ON fechamentos;
DROP TABLE oportunidades_acoes, oportunidades_marcos, oportunidades_resumos;
DROP FUNCTION oportunidades_integridade(), oportunidades_marcar_etapa(), oportunidades_confirmar();
ALTER TABLE marketing_contatos DROP CONSTRAINT oportunidades_contato_perda_ck, DROP COLUMN responsavel_id, DROP COLUMN perda_motivo, DROP COLUMN perda_observacao, DROP COLUMN perdida_em;
ALTER TABLE fechamentos DROP CONSTRAINT oportunidades_fechamento_perda_ck, DROP COLUMN perda_motivo, DROP COLUMN perda_observacao, DROP COLUMN perdida_em, DROP COLUMN confirmada_em;
COMMIT;
