-- Somente leitura. A 132 exige 082 e 085 e ainda não pode estar aplicada.
DO $$
BEGIN
  IF to_regclass('public.marketing_contatos') IS NULL OR to_regclass('public.whatsapp_atendimento_controles_contato') IS NULL THEN
    RAISE EXCEPTION '132 requer as estruturas 082 e 085';
  END IF;
  IF to_regclass('public.whatsapp_atendimento_oportunidades') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.whatsapp_atendimento_conversas'::regclass
                AND attname = 'oportunidade_pendente_em' AND NOT attisdropped) THEN
    RAISE EXCEPTION '132 já presente';
  END IF;
END $$;
