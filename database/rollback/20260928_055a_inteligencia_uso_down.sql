-- Rollback da 055a. NÃO EXECUTAR sem autorização explícita (docs/OPERACAO_AGENTES.md).
-- Procedimento completo em docs/INTELIGENCIA_PRODUCAO_V1.md (flags → drenar → precheck → down → verificação).
--
-- Fail closed, numa transação só:
--   1. lock_timeout curto: se a aplicação ainda segura as tabelas, aborta em vez de enfileirar.
--   2. trava ACCESS EXCLUSIVE antes de conferir: nenhuma reserva ou uso novo entra depois da checagem.
--   3. reconfere sob a trava; qualquer condição insegura aborta tudo (nada é removido).
-- Recusa: 055c ainda instalada (usa kidmais_055_somente_insercao); reserva ABERTA (chamada em voo);
-- histórico de uso sem decisão explícita de descarte (SET LOCAL kidmais.rollback_055a_descartar_uso = 'sim').
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$ BEGIN
  IF to_regclass('public.ia_uso_modelo') IS NULL OR to_regclass('public.ia_orcamento_reservas') IS NULL THEN
    RAISE EXCEPTION '055a ausente: nada a remover.';
  END IF;
  IF to_regclass('public.ia_documentos') IS NOT NULL THEN
    RAISE EXCEPTION 'Rollback da 055a recusado: remova antes a 055c (e a 055d).';
  END IF;
END $$;

LOCK TABLE ia_orcamento_reservas, ia_uso_modelo IN ACCESS EXCLUSIVE MODE;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM ia_orcamento_reservas WHERE estado = 'ABERTA') THEN
    RAISE EXCEPTION 'Rollback da 055a recusado: há reserva de orçamento aberta (chamada em andamento). Desligue as flags e drene.';
  END IF;
  IF (EXISTS (SELECT 1 FROM ia_uso_modelo) OR EXISTS (SELECT 1 FROM ia_orcamento_reservas))
     AND COALESCE(current_setting('kidmais.rollback_055a_descartar_uso', true), '') <> 'sim' THEN
    RAISE EXCEPTION 'Rollback da 055a recusado: há histórico de uso. Exporte ia_uso_diario e confirme o descarte com SET LOCAL kidmais.rollback_055a_descartar_uso = ''sim''.';
  END IF;
END $$;

DROP VIEW ia_uso_diario;
DROP TABLE ia_uso_modelo;
DROP TABLE ia_orcamento_reservas;
DROP FUNCTION kidmais_055a_reserva_guarda();
DROP FUNCTION kidmais_055_somente_insercao();

COMMIT;
