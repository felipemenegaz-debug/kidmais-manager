-- 117 precheck PREPARADO, NÃO EXECUTADO. Somente leitura. Exige a 060 (atendimento) e a ausência de qualquer objeto da 117.
BEGIN TRANSACTION READ ONLY;
SET LOCAL search_path = public, pg_catalog;
DO $$ BEGIN
  IF to_regclass('public.whatsapp_atendimento_mensagens') IS NULL OR to_regclass('public.whatsapp_atendimento_status') IS NULL
    THEN RAISE EXCEPTION '117 precheck: 060 ausente'; END IF;
  IF to_regclass('public.whatsapp_atendimento_rodizio') IS NOT NULL OR to_regclass('public.whatsapp_atendimento_status_colisoes') IS NOT NULL
    THEN RAISE EXCEPTION '117 precheck: 117 já (parcialmente) presente'; END IF;
END $$;
-- Identificadores do provedor já repetidos entre saídas do mesmo ambiente (informativo: o código novo não aplica status a eles).
SELECT current_database() AS banco,
  (SELECT count(*) FROM (SELECT 1 FROM whatsapp_atendimento_mensagens WHERE provedor_id IS NOT NULL AND direcao = 'SAIDA'
     GROUP BY ambiente, provedor_id HAVING count(*) > 1) d) AS identificadores_repetidos,
  to_regclass('public.whatsapp_atendimento_mensagens_ambiente_provedor_idx') IS NOT NULL AS indice_ja_existe,
  true AS aprovado;
ROLLBACK;
