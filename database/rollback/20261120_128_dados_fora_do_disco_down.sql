-- Rollback da 128 (dados do disco no banco) — PREPARADO, NÃO EXECUTADO.
-- Com o disco já removido, apagar a tabela ou a coluna perde as regras legadas e o PDF da tabela de pacotes, que não se
-- refazem sozinhos. Por isso só roda com a confirmação explícita na mesma sessão:
--   SET kidmais.rollback_128 = 'descartar-copias';
-- Sem ela, recusa sem alterar nada. Antes, devolva o conteúdo ao disco (se ele ainda existir). Quem decide é uma pessoa.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;

DO $$
BEGIN
  IF current_setting('kidmais.rollback_128', true) IS DISTINCT FROM 'descartar-copias' THEN
    RAISE EXCEPTION '128 down: falta SET kidmais.rollback_128 = ''descartar-copias''; nada foi alterado';
  END IF;
  IF to_regclass('public.disponibilidade_config_legada') IS NULL THEN
    RAISE EXCEPTION '128 down: a 128 não está aplicada';
  END IF;
END $$;

ALTER TABLE documentos_publicos DROP CONSTRAINT documentos_publicos_conteudo_confere;
ALTER TABLE documentos_publicos DROP COLUMN conteudo;
DROP TABLE disponibilidade_config_legada;

COMMIT;
