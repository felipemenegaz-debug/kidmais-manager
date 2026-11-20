-- Rollback da 127 (marca de saída por telefone/e-mail) — PREPARADO, NÃO EXECUTADO.
-- Apagar a tabela perde marcas que NÃO se refazem (cliente recadastrado depois da saída, PARAR expurgado). Por isso só
-- roda com a confirmação explícita na mesma sessão:  SET kidmais.rollback_127 = 'descartar-marcas';
-- Sem ela, recusa sem alterar nada. Quem decide é uma pessoa, nunca este script.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;

DO $$
BEGIN
  IF current_setting('kidmais.rollback_127', true) IS DISTINCT FROM 'descartar-marcas' THEN
    RAISE EXCEPTION '127 down: falta SET kidmais.rollback_127 = ''descartar-marcas''; nada foi alterado';
  END IF;
  IF to_regclass('public.marketing_saidas_contato') IS NULL THEN
    RAISE EXCEPTION '127 down: a 127 não está aplicada';
  END IF;
END $$;

DROP TRIGGER marketing_saidas_por_atendimento ON whatsapp_atendimento_conversas;
DROP TRIGGER marketing_saidas_contato_novo ON clientes;
DROP TRIGGER marketing_saidas_por_preferencia ON marketing_contato_preferencias;
DROP FUNCTION kidmais127_saida_por_atendimento();
DROP FUNCTION kidmais127_saida_contato_novo();
DROP FUNCTION kidmais127_saida_por_preferencia();
DROP TABLE marketing_saidas_contato;
DROP FUNCTION kidmais127_marcar_cliente(uuid, uuid, text, timestamptz, uuid);
DROP FUNCTION kidmais127_saida_controle();
DROP FUNCTION kidmais127_email(text);

COMMIT;
