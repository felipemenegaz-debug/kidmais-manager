-- 083 precheck (somente leitura). Pré-requisitos: 018 (whatsapp_conexoes) e 031 (empresas); 083 ausente.
-- Informa as conexões antigas da plataforma (sem empresa), que ficam inertes e preservadas.
DO $$ BEGIN
  IF to_regclass('public.whatsapp_conexoes') IS NULL OR to_regclass('public.whatsapp_onboarding_tentativas') IS NULL THEN
    RAISE EXCEPTION '083 precheck: 018 não aplicada.';
  END IF;
  IF to_regclass('public.empresas') IS NULL THEN RAISE EXCEPTION '083 precheck: 031 não aplicada (empresas).'; END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'whatsapp_conexoes' AND column_name = 'empresa_id') THEN
    RAISE EXCEPTION '083 precheck: já aplicada.';
  END IF;
  IF EXISTS (SELECT 1 FROM whatsapp_conexoes WHERE status = 'CONFIGURADA' GROUP BY ambiente, phone_number_id HAVING count(*) > 1) THEN
    RAISE EXCEPTION '083 precheck: número com mais de uma conexão CONFIGURADA no mesmo ambiente.';
  END IF;
  RAISE NOTICE '083 precheck OK: conexões da plataforma CONFIGURADAS = %, DESCONECTADAS = %, tentativas em andamento = %',
    (SELECT count(*) FROM whatsapp_conexoes WHERE status = 'CONFIGURADA'),
    (SELECT count(*) FROM whatsapp_conexoes WHERE status = 'DESCONECTADA'),
    (SELECT count(*) FROM whatsapp_onboarding_tentativas WHERE status IN ('INICIADA', 'VALIDANDO'));
END $$;
