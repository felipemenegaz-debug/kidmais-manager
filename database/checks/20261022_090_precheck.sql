-- Somente leitura. Confirma as dependências da 090 (empresas, usuários, Convites 073/084, cobrança 067/068) e que ela
-- ainda não foi aplicada, nem parcialmente.
DO $$
BEGIN
  IF to_regclass('public.empresas') IS NULL OR to_regclass('public.usuarios_administrativos') IS NULL
    OR to_regclass('public.convite_carteiras') IS NULL OR to_regclass('public.convite_geracoes') IS NULL
    OR to_regclass('public.cobranca_eventos') IS NULL OR to_regclass('public.empresa_assinaturas') IS NULL THEN
    RAISE EXCEPTION '090 precheck: empresas, usuarios_administrativos, convite_carteiras, convite_geracoes, cobranca_eventos ou empresa_assinaturas ausente';
  END IF;
  IF to_regclass('public.ia_credito_carteiras') IS NOT NULL OR to_regclass('public.ia_credito_pedidos') IS NOT NULL
    OR to_regclass('public.ia_credito_lotes') IS NOT NULL OR to_regclass('public.ia_credito_lancamentos') IS NOT NULL
    OR to_regclass('public.ia_credito_reservas') IS NOT NULL OR to_regclass('public.ia_credito_reserva_lotes') IS NOT NULL
    OR to_regclass('public.ia_credito_cobrancas') IS NOT NULL OR to_regclass('public.ia_credito_devolucoes') IS NOT NULL
    OR to_regclass('public.ia_credito_cortesias') IS NOT NULL OR to_regclass('public.ia_credito_cortes') IS NOT NULL
    OR to_regclass('public.ia_credito_notificacoes') IS NOT NULL OR to_regprocedure('public.kidmais_090_guarda()') IS NOT NULL THEN
    RAISE EXCEPTION '090 precheck: aplicação anterior ou parcial encontrada';
  END IF;
  RAISE NOTICE '090 precheck OK';
END $$;
-- Contagens informativas (sem ids nem dados pessoais): carteiras do motor legado e gerações abertas (o corte exige zero).
SELECT (SELECT count(*) FROM convite_carteiras WHERE ativo)::int AS carteiras_legado_ativas,
       (SELECT count(*) FROM convite_geracoes WHERE estado IN ('RESERVADA', 'INCERTA'))::int AS geracoes_abertas;
