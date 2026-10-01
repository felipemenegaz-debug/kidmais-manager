-- Rollback da 055c. NÃO EXECUTAR sem autorização explícita (docs/OPERACAO_AGENTES.md).
-- Procedimento completo em docs/INTELIGENCIA_PRODUCAO_V1.md (flags → drenar → precheck → down → verificação).
--
-- Fail closed, numa transação só: lock_timeout curto, trava ACCESS EXCLUSIVE das quatro tabelas ANTES
-- de conferir e reconferência sob a trava (um upload concorrente ou espera e falha, ou já gravou e é visto).
-- Recusa: 055d ainda instalada, ou qualquer documento registrado (originais de clientes exigem decisão
-- humana de retenção/descarte — LGPD — e plano próprio; este script nunca apaga documento).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$ BEGIN
  IF to_regclass('public.ia_documentos') IS NULL THEN
    RAISE EXCEPTION '055c ausente: nada a remover.';
  END IF;
  IF to_regclass('public.ia_importacoes') IS NOT NULL THEN
    RAISE EXCEPTION 'Rollback da 055c recusado: remova antes a 055d.';
  END IF;
END $$;

LOCK TABLE ia_documentos, ia_documento_originais, ia_extracoes, ia_evidencias IN ACCESS EXCLUSIVE MODE;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM ia_documentos) OR EXISTS (SELECT 1 FROM ia_documento_originais)
     OR EXISTS (SELECT 1 FROM ia_extracoes) OR EXISTS (SELECT 1 FROM ia_evidencias) THEN
    RAISE EXCEPTION 'Rollback da 055c recusado: há documentos registrados. Retenção/descarte exige decisão humana.';
  END IF;
END $$;

DROP TABLE ia_evidencias;
DROP TABLE ia_extracoes;
DROP TABLE ia_documento_originais;
DROP TABLE ia_documentos;
DROP FUNCTION kidmais_055_documento_guarda();

COMMIT;
