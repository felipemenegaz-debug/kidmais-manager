-- Rollback da 090. Recusa se houver qualquer campanha (inclusive rascunho) ou concessão que não seja LEGADO: depois de
-- concessões da janela (sem vaga, possivelmente mais de 20) o código antigo não é rollback seguro — desligue a campanha e
-- corrija para frente. ANTES do rollback, volte o código para a versão anterior. Concessões LEGADO voltam intactas.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;
DO $$
BEGIN
  IF to_regclass('public.assinatura_campanhas') IS NULL OR to_regprocedure('public.kidmais_090_fundador_guarda()') IS NULL THEN
    RAISE EXCEPTION '090 rollback recusado: migration ausente ou parcial.';
  END IF;
END $$;
LOCK TABLE assinatura_fundadores IN ACCESS EXCLUSIVE MODE;
LOCK TABLE assinatura_campanhas IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM assinatura_campanhas) OR EXISTS (SELECT 1 FROM assinatura_fundadores WHERE origem <> 'LEGADO' OR vaga IS NULL) THEN
    RAISE EXCEPTION '090 rollback recusado: há campanha registrada ou concessão da campanha nova. Preserve e corrija para frente.';
  END IF;
END $$;
DROP TRIGGER assinatura_fundadores_090_campanha ON assinatura_fundadores;
DROP INDEX assinatura_fundadores_vaga_legado_uk;
DROP INDEX assinatura_fundadores_vaga_pos_uk;
DROP INDEX assinatura_fundadores_campanha_idx;
ALTER TABLE assinatura_fundadores
  DROP CONSTRAINT assinatura_fundadores_vaga_check,
  DROP CONSTRAINT assinatura_fundadores_campanha_check,
  DROP COLUMN campanha_id, DROP COLUMN origem, DROP COLUMN regra_versao, DROP COLUMN oferta_valida_ate,
  ALTER COLUMN vaga SET NOT NULL,
  ADD CONSTRAINT assinatura_fundadores_vaga_check CHECK (vaga BETWEEN 1 AND 20);
CREATE UNIQUE INDEX assinatura_fundadores_vaga_uk ON assinatura_fundadores(vaga) WHERE estado <> 'LIBERADA';
DROP TABLE assinatura_campanhas;
DROP FUNCTION kidmais_090_fundador_guarda();
DROP FUNCTION kidmais_090_campanha_guarda();
COMMIT;
