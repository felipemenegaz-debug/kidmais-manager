-- Somente leitura. Estrutura da 132 completa e a guarda da 085 (sem DELETE em marketing_contatos) intacta.
DO $$
DECLARE faltando text;
BEGIN
  SET LOCAL search_path = public, pg_catalog;
  SELECT string_agg(c, ', ') INTO faltando FROM unnest(ARRAY['contato_id','empresa_id','ambiente','conversa_id','criado_em','anonimizado_em']) AS c
   WHERE NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = to_regclass('public.whatsapp_atendimento_oportunidades') AND a.attname = c AND NOT a.attisdropped);
  IF to_regclass('public.whatsapp_atendimento_oportunidades') IS NULL OR faltando IS NOT NULL THEN
    RAISE EXCEPTION '132: tabela de vínculo incompleta (%)', coalesce(faltando, 'tabela ausente');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.whatsapp_atendimento_conversas'::regclass AND attname = 'oportunidade_pendente_em' AND NOT attisdropped) THEN
    RAISE EXCEPTION '132: coluna de pendência ausente';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.whatsapp_atendimento_oportunidades'::regclass AND conname = 'walle_oportunidades_ambiente' AND convalidated) THEN
    RAISE EXCEPTION '132: CHECK de ambiente ausente ou não validado';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.whatsapp_atendimento_oportunidades'::regclass AND contype = 'f'
      AND confrelid = 'public.whatsapp_atendimento_conversas'::regclass AND confdeltype = 'n') THEN
    RAISE EXCEPTION '132: vínculo com a conversa precisa de ON DELETE SET NULL';
  END IF;
  IF (SELECT pg_get_triggerdef(t.oid) FROM pg_trigger t WHERE t.tgrelid = 'public.whatsapp_atendimento_oportunidades'::regclass
      AND t.tgname = 'kidmais132_oportunidade_guarda' AND t.tgenabled = 'O' AND NOT t.tgisinternal)
      IS DISTINCT FROM 'CREATE TRIGGER kidmais132_oportunidade_guarda BEFORE INSERT OR DELETE OR UPDATE ON public.whatsapp_atendimento_oportunidades FOR EACH ROW EXECUTE FUNCTION kidmais132_oportunidade_guarda()' THEN
    RAISE EXCEPTION '132: gatilho de guarda divergente';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.marketing_contatos'::regclass AND tgname = 'marketing_contatos_tenant' AND tgenabled = 'O') THEN
    RAISE EXCEPTION '132: guarda da 085 em marketing_contatos ausente';
  END IF;
END $$;
