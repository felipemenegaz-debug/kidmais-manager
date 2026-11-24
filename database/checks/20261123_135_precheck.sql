-- Somente leitura. A 135 exige o atendimento (060) e ainda não pode estar aplicada.
DO $$
BEGIN
  SET LOCAL search_path = public, pg_catalog;
  IF to_regclass('public.whatsapp_atendimento_mensagens') IS NULL OR to_regclass('public.empresas') IS NULL THEN
    RAISE EXCEPTION '135 requer a 060 (whatsapp_atendimento_mensagens) e empresas';
  END IF;
  IF to_regclass('public.whatsapp_atendimento_consumo_mensal') IS NOT NULL THEN
    RAISE EXCEPTION '135 já presente';
  END IF;
END $$;
