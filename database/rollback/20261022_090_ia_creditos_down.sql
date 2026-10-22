-- Rollback da 090. Recusa quando existe QUALQUER registro do domínio (carteira, lote, extrato, reserva, pedido,
-- cobrança, devolução, cortesia, corte ou notificação): são obrigações financeiras e a prova delas. Nesse caso,
-- desligue as flags CREDITOS_* (venda e consumo novo), mantenha o processamento de pagamentos/devoluções e corrija para frente.
-- Empresa com corte registrado nunca volta ao motor legado por este caminho (a recusa protege o saldo convertido).
-- ANTES do rollback, volte o código para a versão anterior (o código da 090 só usa as tabelas quando elas existem).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;
DO $$
BEGIN
  IF to_regclass('public.ia_credito_carteiras') IS NULL OR to_regclass('public.ia_credito_lancamentos') IS NULL
    OR to_regprocedure('public.kidmais_090_guarda()') IS NULL THEN
    RAISE EXCEPTION '090 rollback recusado: migration ausente ou parcial.';
  END IF;
END $$;
LOCK TABLE ia_credito_carteiras, ia_credito_pedidos, ia_credito_lotes, ia_credito_lancamentos, ia_credito_reservas, ia_credito_reserva_lotes,
  ia_credito_cobrancas, ia_credito_devolucoes, ia_credito_cortesias, ia_credito_cortes, ia_credito_notificacoes IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM ia_credito_carteiras) OR EXISTS (SELECT 1 FROM ia_credito_pedidos) OR EXISTS (SELECT 1 FROM ia_credito_lotes)
    OR EXISTS (SELECT 1 FROM ia_credito_lancamentos) OR EXISTS (SELECT 1 FROM ia_credito_reservas) OR EXISTS (SELECT 1 FROM ia_credito_reserva_lotes)
    OR EXISTS (SELECT 1 FROM ia_credito_cobrancas) OR EXISTS (SELECT 1 FROM ia_credito_devolucoes) OR EXISTS (SELECT 1 FROM ia_credito_cortesias)
    OR EXISTS (SELECT 1 FROM ia_credito_cortes) OR EXISTS (SELECT 1 FROM ia_credito_notificacoes) THEN
    RAISE EXCEPTION '090 rollback recusado: há registros de créditos (obrigações financeiras). Preserve e corrija para frente.';
  END IF;
END $$;
DROP TABLE ia_credito_notificacoes, ia_credito_cortes, ia_credito_cortesias, ia_credito_devolucoes, ia_credito_cobrancas, ia_credito_reserva_lotes,
  ia_credito_reservas, ia_credito_lancamentos, ia_credito_lotes, ia_credito_pedidos, ia_credito_carteiras;
DROP FUNCTION kidmais_090_guarda();
COMMIT;
