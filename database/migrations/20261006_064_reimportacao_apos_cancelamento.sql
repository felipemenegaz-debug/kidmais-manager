-- 064 — Reimportação de contrato histórico depois do cancelamento do contrato integrado.
--
-- NÃO APLICADA. Exige autorização explícita (docs/OPERACAO_AGENTES.md) para qualquer banco, inclusive staging e clones.
--
-- Problema: a 055c guarda um documento por arquivo (sha256 único por empresa); a 055d permite uma importação ativa
-- (EM_REVISAO ou IMPORTADA) por documento e trata IMPORTADA como estado terminal; a 061 liga a importação ao contrato
-- integrado e é imutável. Depois de cancelar o contrato integrado, o mesmo arquivo não pode ser importado de novo:
-- o documento continua ocupado pela importação concluída, para sempre.
--
-- Regra nova (a única mudança): importação IMPORTADA cujo contrato integrado (contrato_importacoes → contratos) está
-- CANCELADO pode passar a DESCARTADA, com versão avançando e identidade imutável. A 055d já exige cliente_id e
-- resultado nulos em DESCARTADA; o código preserva o resultado anterior em dados->'substituicao'. O vínculo histórico
-- (contrato_importacoes) e o contrato cancelado não mudam. Toda outra transição continua recusada como na 055d.
-- Nenhuma linha existente é alterada por esta migration. A função da 055d permanece para o rollback reapontar o gatilho.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = public, pg_catalog;

DO $$ BEGIN
  IF to_regprocedure('public.kidmais064_contrato_cancelado(uuid)') IS NOT NULL THEN RAISE EXCEPTION '064 já aplicada.'; END IF;
  IF to_regclass('public.ia_importacoes') IS NULL OR to_regprocedure('public.kidmais_055_importacao_guarda()') IS NULL THEN
    RAISE EXCEPTION '064 exige a 055d (ia_importacoes e sua guarda).';
  END IF;
  IF to_regclass('public.contrato_importacoes') IS NULL THEN RAISE EXCEPTION '064 exige a 061 (contrato_importacoes).'; END IF;
  IF (SELECT tgfoid FROM pg_trigger WHERE tgrelid = 'public.ia_importacoes'::regclass AND tgname = 'ia_importacoes_055_guarda_trg')
     IS DISTINCT FROM 'public.kidmais_055_importacao_guarda()'::regprocedure THEN
    RAISE EXCEPTION '064: o gatilho de guarda da importação não aponta para a 055d.';
  END IF;
END $$;

-- Contrato integrado desta importação está cancelado? (061: um vínculo por importação.)
CREATE FUNCTION kidmais064_contrato_cancelado(importacao uuid) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.contrato_importacoes ci JOIN public.contratos c ON c.id = ci.contrato_id
     WHERE ci.importacao_id = importacao AND c.status = 'CANCELADO'
  )
$$;

-- Corpo da 055d com UM ramo a mais (IMPORTADA → DESCARTADA com contrato cancelado). Demais regras idênticas.
CREATE FUNCTION kidmais_064_importacao_guarda() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ia_importacoes não é apagada.' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.id <> OLD.id OR NEW.empresa_id <> OLD.empresa_id OR NEW.documento_id <> OLD.documento_id
     OR NEW.extracao_id <> OLD.extracao_id OR NEW.criado_por <> OLD.criado_por THEN
    RAISE EXCEPTION 'Identidade da importação é imutável.' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.versao <= OLD.versao THEN
    RAISE EXCEPTION 'Versão da importação só avança.' USING ERRCODE = 'P0001';
  END IF;
  -- 064: a única saída de IMPORTADA é DESCARTADA, e só com o contrato integrado cancelado
  -- (libera o documento para uma nova importação; o vínculo histórico da 061 não muda).
  IF OLD.status = 'IMPORTADA' THEN
    IF NEW.status = 'DESCARTADA' AND public.kidmais064_contrato_cancelado(OLD.id) THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'Importação encerrada não muda.' USING ERRCODE = 'P0001';
  END IF;
  -- Estados terminais: só EM_REVISAO muda, e só para EM_REVISAO, IMPORTADA ou DESCARTADA.
  IF OLD.status <> 'EM_REVISAO' THEN
    RAISE EXCEPTION 'Importação encerrada não muda.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE TRIGGER ia_importacoes_055_guarda_trg BEFORE UPDATE OR DELETE ON ia_importacoes
  FOR EACH ROW EXECUTE FUNCTION kidmais_064_importacao_guarda();

COMMIT;
