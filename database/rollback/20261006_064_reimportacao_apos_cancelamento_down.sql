-- Rollback 064 — devolve o gatilho de guarda da importação à 055d e remove as funções da 064.
-- NÃO EXECUTAR sem autorização explícita (docs/OPERACAO_AGENTES.md).
--
-- A 064 só acrescenta uma transição; o código anterior roda com ela presente, então voltar o CÓDIGO não exige este
-- rollback. Importações já substituídas (DESCARTADA com dados->'substituicao') são histórico válido também na 055d
-- (DESCARTADA é terminal lá); nada é alterado nelas e nenhum dado é apagado.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = public, pg_catalog;
LOCK TABLE ia_importacoes IN ACCESS EXCLUSIVE MODE;

DO $$ BEGIN
  IF to_regprocedure('public.kidmais_064_importacao_guarda()') IS NULL OR to_regprocedure('public.kidmais064_contrato_cancelado(uuid)') IS NULL THEN
    RAISE EXCEPTION 'Rollback 064: 064 ausente.';
  END IF;
  IF to_regprocedure('public.kidmais_055_importacao_guarda()') IS NULL THEN
    RAISE EXCEPTION 'Rollback 064: guarda da 055d ausente; nada a reapontar.';
  END IF;
  IF (SELECT tgfoid FROM pg_trigger WHERE tgrelid = 'public.ia_importacoes'::regclass AND tgname = 'ia_importacoes_055_guarda_trg')
     IS DISTINCT FROM 'public.kidmais_064_importacao_guarda()'::regprocedure THEN
    RAISE EXCEPTION 'Rollback 064: o gatilho de guarda não aponta para a 064.';
  END IF;
END $$;

CREATE OR REPLACE TRIGGER ia_importacoes_055_guarda_trg BEFORE UPDATE OR DELETE ON ia_importacoes
  FOR EACH ROW EXECUTE FUNCTION kidmais_055_importacao_guarda();
DROP FUNCTION kidmais_064_importacao_guarda();
DROP FUNCTION kidmais064_contrato_cancelado(uuid);

COMMIT;
