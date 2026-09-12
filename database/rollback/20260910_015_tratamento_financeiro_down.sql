BEGIN;
SET LOCAL lock_timeout='5s';
DO $$ DECLARE t text; populated boolean; BEGIN
 FOREACH t IN ARRAY ARRAY['pagamento_gestoes','pagamento_tratamentos','pagamento_eventos','pagamento_ajustes_contratuais','pagamento_cronogramas','pagamento_cronograma_itens','pagamento_movimentos_contextos','pagamento_credito_reservas','pagamento_devolucoes','pagamento_devolucao_alocacoes','pagamento_devolucao_comprovantes','pagamento_ajuste_bases'] LOOP
 EXECUTE format('LOCK TABLE %I IN ACCESS EXCLUSIVE MODE',t);
 EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I)',t) INTO populated;
 IF populated THEN RAISE EXCEPTION 'Rollback recusado: % contém histórico 015',t USING ERRCODE='23514'; END IF;
 END LOOP;
END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['pagamentos','pagamento_parcelas','pagamento_recebimentos','pagamento_estornos','pagamento_recebimento_alocacoes','pagamento_comprovantes'] LOOP
 EXECUTE format('DROP TRIGGER p015_legado ON %I',t);
 END LOOP;
END $$;
DROP TABLE pagamento_ajuste_bases,pagamento_devolucao_comprovantes,pagamento_devolucao_alocacoes,pagamento_devolucoes,pagamento_credito_reservas,pagamento_movimentos_contextos,pagamento_cronograma_itens,pagamento_cronogramas,pagamento_ajustes_contratuais,pagamento_eventos,pagamento_tratamentos,pagamento_gestoes;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['pagamentos','pagamento_parcelas','pagamento_recebimentos','pagamento_estornos','pagamento_recebimento_alocacoes'] LOOP
 EXECUTE format('DROP TRIGGER p015_validar_movimento ON %I',t);
 END LOOP;
END $$;
DROP FUNCTION kidmais_015_validar(),kidmais_015_proteger_legado(),kidmais_015_processo(),kidmais_015_imutavel();
COMMIT;
