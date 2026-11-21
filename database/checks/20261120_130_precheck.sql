DO $$
BEGIN
  IF to_regclass('public.empresa_pix_recebimento') IS NULL OR to_regclass('public.agenda_saloes') IS NULL
     OR to_regclass('public.fechamentos') IS NULL OR to_regclass('public.memberships') IS NULL THEN
    RAISE EXCEPTION '130: faltam dependências de tenant, fechamento, Pix ou agenda';
  END IF;
  IF EXISTS (SELECT FROM pg_class WHERE relnamespace='public'::regnamespace AND relname IN
     ('pre_reserva_configuracoes','pre_reserva_aceites','pre_reserva_recebimentos','pre_reserva_situacoes',
      'pre_reserva_fechamento_titular','pre_reserva_contrato_pedido','pre_reserva_um_sinal_por_pedido','pre_reserva_pendencias_por_empresa')) THEN
    RAISE EXCEPTION '130: instalação já existente ou parcial';
  END IF;
END $$;
