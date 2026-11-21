-- Catálogo canônico do PostgreSQL 18. Somente leitura, inclusive em bases com dados.
DO $$
DECLARE item record;
BEGIN
  SET LOCAL search_path = public, pg_catalog;
  FOR item IN SELECT * FROM (VALUES
      ('kidmais062_ocupacoes_escopo(date,date)', 'f8b330d85ffd487c1d1f449bf5e5e4a3843d1668a3628ddb38f819281be8c408'),
      ('kidmais094_ocupacoes(date,date)', '2fd9540c61c1d30bd64e53e912b90799e3cd6ab48d38f04ea82efe3f21385646'),
      ('pre_reserva_exigir_configuracao()', '52892467d0635c1f3c63836c2d6f17c986ba77336eac0c8393688f68131d66ab'),
      ('pre_reserva_preservar_destino()', 'fccab2c4b90868eccc8e25936b77e6406c50cc8124922a9b106a01e7a8c98bd8')
    ) AS esperado(assinatura, hash) LOOP
    IF (SELECT encode(sha256(convert_to(replace(pg_get_functiondef(p.oid), chr(13), ''), 'UTF8')), 'hex')
        FROM pg_proc p WHERE p.oid = to_regprocedure('public.' || item.assinatura)) IS DISTINCT FROM item.hash THEN
      RAISE EXCEPTION '131: definição divergente da função %', item.assinatura;
    END IF;
  END LOOP;
  FOR item IN SELECT * FROM (VALUES
      ('fechamentos', 'pre_reserva_destino_garantido', 'CREATE TRIGGER pre_reserva_destino_garantido BEFORE UPDATE OF data_evento, horario_inicio, horario_fim, configuracao_agenda_id, estabelecimento_id, salao_id, salao_preferido_id ON public.fechamentos FOR EACH ROW EXECUTE FUNCTION pre_reserva_preservar_destino()'),
      ('pre_reserva_aceites', 'a131_config_antes_do_aceite', 'CREATE TRIGGER a131_config_antes_do_aceite BEFORE INSERT ON public.pre_reserva_aceites FOR EACH ROW EXECUTE FUNCTION pre_reserva_exigir_configuracao()'),
      ('pre_reserva_recebimentos', 'a131_config_antes_do_recebimento', 'CREATE TRIGGER a131_config_antes_do_recebimento BEFORE INSERT ON public.pre_reserva_recebimentos FOR EACH ROW EXECUTE FUNCTION pre_reserva_exigir_configuracao()'),
      ('pre_reserva_recebimentos', 'pre_reserva_motivo_historico', 'CREATE TRIGGER pre_reserva_motivo_historico BEFORE UPDATE OF motivo_sem_garantia ON public.pre_reserva_recebimentos FOR EACH ROW WHEN ((old.motivo_sem_garantia IS DISTINCT FROM new.motivo_sem_garantia)) EXECUTE FUNCTION pre_reserva_exigir_configuracao()')
    ) AS esperado(tabela, nome, definicao) LOOP
    IF (SELECT pg_get_triggerdef(t.oid) FROM pg_trigger t
        WHERE t.tgrelid = to_regclass('public.' || item.tabela) AND t.tgname = item.nome
          AND t.tgenabled = 'O' AND NOT t.tgisinternal) IS DISTINCT FROM item.definicao THEN
      RAISE EXCEPTION '131: definição divergente do gatilho %.%', item.tabela, item.nome;
    END IF;
  END LOOP;
END $$;
