BEGIN READ ONLY;
DO $$ BEGIN
 IF to_regclass('pagamento_gestoes') IS NOT NULL THEN RAISE EXCEPTION '015 já instalada'; END IF;
 IF to_regclass('contrato_pendencias_financeiras') IS NULL OR to_regclass('fechamento_revisoes') IS NULL THEN RAISE EXCEPTION 'Pré-requisitos 013/014 ausentes'; END IF;
 IF EXISTS(SELECT v.contrato_id FROM pagamentos p JOIN contrato_versoes v ON v.id=p.contrato_versao_id GROUP BY v.contrato_id HAVING count(*)>1) THEN RAISE EXCEPTION 'Múltiplas obrigações originais na mesma contratação'; END IF;
 IF EXISTS(SELECT 1 FROM pagamentos p JOIN contrato_versoes v ON v.id=p.contrato_versao_id WHERE v.status<>'ASSINADA' OR p.valor_total_contratado<>(v.snapshot->'comercial'->>'valorFinalContrato')::numeric) THEN RAISE EXCEPTION 'Obrigação original divergente'; END IF;
 IF EXISTS(SELECT 1 FROM pagamento_recebimentos r WHERE r.status='CONFIRMADO' AND r.valor_bruto<>(SELECT coalesce(sum(valor_alocado),0) FROM pagamento_recebimento_alocacoes WHERE recebimento_id=r.id)) THEN RAISE EXCEPTION 'Recebimento sem alocação íntegra'; END IF;
 IF EXISTS(SELECT 1 FROM pagamento_recebimento_alocacoes a WHERE a.valor_alocado<(SELECT coalesce(sum(valor),0) FROM pagamento_estornos WHERE recebimento_id=a.recebimento_id AND parcela_id=a.parcela_id AND status IN ('SOLICITADO','CONFIRMADO'))) THEN RAISE EXCEPTION 'Estorno excede origem'; END IF;
END $$;
COMMIT;
