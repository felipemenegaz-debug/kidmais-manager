-- 127 precheck PREPARADO, NÃO EXECUTADO. Somente leitura. Confere a 086 e a 060 e nada da 127.
BEGIN TRANSACTION READ ONLY;
SET LOCAL search_path = public, pg_catalog;
DO $$
BEGIN
  IF to_regclass('public.marketing_contato_preferencias') IS NULL OR to_regprocedure('public.kidmais086_destino(text)') IS NULL
     OR to_regprocedure('public.kidmais085_somente_insercao()') IS NULL THEN
    RAISE EXCEPTION '127 precheck: exige a 086';
  END IF;
  IF to_regclass('public.whatsapp_atendimento_conversas') IS NULL THEN
    RAISE EXCEPTION '127 precheck: exige a 060';
  END IF;
  IF to_regclass('public.marketing_saidas_contato') IS NOT NULL OR to_regprocedure('public.kidmais127_email(text)') IS NOT NULL THEN
    RAISE EXCEPTION '127 precheck: 127 já presente (inteira ou parcial)';
  END IF;
END $$;
-- Contagens sem dado pessoal: quantos descadastros e números com nao_contatar a carga inicial vai ler.
SELECT current_database() AS banco, true AS aprovado,
  (SELECT count(*) FROM marketing_contato_preferencias WHERE descadastrado_em IS NOT NULL) AS descadastros,
  (SELECT count(*) FROM whatsapp_atendimento_conversas WHERE nao_contatar) AS conversas_nao_contatar;
ROLLBACK;
