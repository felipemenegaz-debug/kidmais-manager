-- PREPARADO, NÃO EXECUTADO. Nunca descartar evidências de envio ou alteração de preço.
BEGIN;
SET LOCAL lock_timeout = '5s';
LOCK TABLE public.assinatura_renovacoes IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.assinatura_renovacoes) THEN RAISE EXCEPTION '075: rollback recusado com histórico.'; END IF;
END $$;
DROP TABLE public.assinatura_renovacoes;
DROP FUNCTION public.kidmais_075_renovacao_guarda();
COMMIT;
