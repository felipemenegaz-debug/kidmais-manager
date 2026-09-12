BEGIN READ ONLY;
DO $$ DECLARE t text; n integer:=0; BEGIN
 FOREACH t IN ARRAY ARRAY['pagamento_gestoes','pagamento_tratamentos','pagamento_eventos','pagamento_ajustes_contratuais','pagamento_cronogramas','pagamento_cronograma_itens','pagamento_movimentos_contextos','pagamento_credito_reservas','pagamento_devolucoes','pagamento_devolucao_alocacoes','pagamento_devolucao_comprovantes','pagamento_ajuste_bases'] LOOP
 IF to_regclass(t) IS NULL THEN RAISE EXCEPTION 'Tabela ausente: %',t; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass(t) AND tgname='p015_validar' AND tgdeferrable) THEN RAISE EXCEPTION 'Validação ausente: %',t; END IF;
 n:=n+1;
 END LOOP;
 IF n<>12 THEN RAISE EXCEPTION 'Estruturas incompletas'; END IF;
 IF (SELECT count(*) FROM pg_trigger WHERE tgname='p015_legado')<>6 THEN RAISE EXCEPTION 'Proteções financeiras incompletas'; END IF;
 IF (SELECT count(*) FROM pg_trigger WHERE tgname='p015_validar_movimento' AND tgdeferrable)<>5 THEN RAISE EXCEPTION 'Validação cruzada dos movimentos incompleta'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='contrato_documentos'::regclass AND tgname='contrato_documentos_imutavel_trg') THEN RAISE EXCEPTION 'Proteção contratual ausente'; END IF;
END $$;
COMMIT;
