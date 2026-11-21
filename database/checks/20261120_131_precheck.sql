DO $$
BEGIN
 IF to_regclass('public.pre_reserva_situacoes') IS NULL OR to_regprocedure('public.kidmais114_exigir_configuracao(uuid)') IS NULL THEN
   RAISE EXCEPTION '131 requer as estruturas 114 e 130';
 END IF;
 IF to_regprocedure('public.pre_reserva_exigir_configuracao()') IS NOT NULL
    OR to_regprocedure('public.pre_reserva_preservar_destino()') IS NOT NULL THEN RAISE EXCEPTION '131 já presente'; END IF;
END $$;
