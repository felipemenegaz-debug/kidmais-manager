-- PREPARADO, NÃO EXECUTADO. Nunca descartar evidências de envio: com qualquer aviso gravado, o rollback é recusado.
BEGIN;
SET LOCAL lock_timeout = '5s';
LOCK TABLE public.assinatura_avisos IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.assinatura_avisos) THEN RAISE EXCEPTION '087: rollback recusado com histórico.'; END IF;
END $$;
DROP TABLE public.assinatura_avisos;
DROP FUNCTION public.kidmais_087_aviso_guarda();
COMMIT;
