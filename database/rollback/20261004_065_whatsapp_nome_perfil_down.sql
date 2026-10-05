-- Rollback da 065. NÃO EXECUTAR sem autorização explícita (docs/OPERACAO_AGENTES.md).
-- O rollback de código não exige este script: sem as colunas a tela só deixa de mostrar o nome de perfil (o serviço
-- confere o catálogo a cada uso). Este down remove a estrutura. Não toca o restante da 060 nem a 064.
--
-- Fail closed, numa transação só:
--   1. lock_timeout curto: se a aplicação ainda segura a tabela, aborta em vez de enfileirar;
--   2. trava ACCESS EXCLUSIVE antes de conferir;
--   3. com nome de perfil gravado, exige exportação prévia e decisão explícita de descarte:
--      SET LOCAL kidmais.rollback_065_descartar_nomes = 'sim'.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$ BEGIN
  IF to_regclass('public.whatsapp_atendimento_conversas') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.whatsapp_atendimento_conversas'::regclass
                     AND attname = 'nome_perfil' AND NOT attisdropped) THEN
    RAISE EXCEPTION '065 ausente: nada a remover.';
  END IF;
END $$;

LOCK TABLE whatsapp_atendimento_conversas IN ACCESS EXCLUSIVE MODE;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM whatsapp_atendimento_conversas WHERE nome_perfil IS NOT NULL)
     AND COALESCE(current_setting('kidmais.rollback_065_descartar_nomes', true), '') <> 'sim' THEN
    RAISE EXCEPTION 'Rollback da 065 recusado: há nomes de perfil gravados. Exporte (empresa_id, ambiente, contato, nome_perfil, nome_perfil_em) e confirme o descarte com SET LOCAL kidmais.rollback_065_descartar_nomes = ''sim''.';
  END IF;
END $$;

ALTER TABLE whatsapp_atendimento_conversas
  DROP CONSTRAINT whatsapp_atendimento_conversas_nome_perfil_par,
  DROP COLUMN nome_perfil_em,
  DROP COLUMN nome_perfil;

COMMIT;
