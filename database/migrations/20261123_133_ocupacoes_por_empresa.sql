-- 133: ocupações do recurso (empresa/unidade) sem varrer as festas da instalação inteira.
-- Contrato: kidmais133_ocupacoes_escopo(i,f,emp,uni) devolve EXATAMENTE as linhas de
--   SELECT * FROM kidmais094_ocupacoes(i,f) o WHERE kidmais062_mesmo_recurso(emp,uni,o.empresa_id,o.estabelecimento_id)
-- mas aplica o filtro de empresa ANTES das funções por linha (kidmais019_ocupa/kidmais061_historico_passado), com o
-- índice fechamentos_115_empresa_data_idx. A 094 não muda: guardas, conflito e calendário público seguem nela.
-- Com emp nulo (agenda global sem 062), devolve a 094 inteira filtrada só pela unidade, como antes.
-- Qualquer mudança futura no corpo da 094 precisa ser repetida aqui (o teste de equivalência compara as duas).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;

-- A 133 copia o corpo da 094 da 131: com outra 094 instalada, recusa ANTES de criar a função (na mesma transação),
-- para a aplicação nunca passar a ler uma 133 que não espelha a 094 vigente (Astra r1, P2).
DO $$
BEGIN
  IF (SELECT encode(sha256(convert_to(replace(pg_get_functiondef(p.oid), chr(13), ''), 'UTF8')), 'hex')
      FROM pg_proc p WHERE p.oid = to_regprocedure('public.kidmais094_ocupacoes(date,date)'))
     IS DISTINCT FROM '2fd9540c61c1d30bd64e53e912b90799e3cd6ab48d38f04ea82efe3f21385646' THEN
    RAISE EXCEPTION '133 requer a 094 exatamente como a 131 a deixou (definição divergente ou ausente)';
  END IF;
END $$;

CREATE FUNCTION public.kidmais133_ocupacoes_escopo(inicio date, fim date, emp uuid, uni uuid)
RETURNS TABLE(fechamento_id uuid, revisao_id uuid, origem text, data date, horario_inicio time, horario_fim time,
              empresa_id uuid, estabelecimento_id uuid, configuracao_agenda_id uuid, salao_id uuid)
LANGUAGE plpgsql STABLE SET search_path = public, pg_catalog AS $$
BEGIN
 IF emp IS NULL THEN
   RETURN QUERY SELECT o.* FROM kidmais094_ocupacoes(inicio,fim) o
    WHERE uni IS NULL OR o.estabelecimento_id IS NULL OR o.estabelecimento_id=uni;
   RETURN;
 END IF;
 RETURN QUERY
 SELECT f.id,NULL::uuid,'CONFIRMADA'::text,f.data_evento,f.horario_inicio,f.horario_fim,f.empresa_id,f.estabelecimento_id,f.configuracao_agenda_id,f.salao_id
 FROM fechamentos f
 WHERE (f.empresa_id=emp OR f.empresa_id IS NULL) AND (uni IS NULL OR f.estabelecimento_id IS NULL OR f.estabelecimento_id=uni)
   AND f.data_evento BETWEEN inicio AND fim AND kidmais019_ocupa(f.id) AND NOT kidmais061_historico_passado(f.id)
 UNION ALL SELECT r.fechamento_id,r.id,'REVISAO_DESTINO'::text,r.data_evento,r.horario_inicio,r.horario_fim,f.empresa_id,f.estabelecimento_id,r.configuracao_agenda_id,COALESCE(r.salao_id,f.salao_id)
 FROM fechamento_revisoes r JOIN fechamentos f ON f.id=r.fechamento_id JOIN contrato_fluxos cf ON cf.contrato_id=r.contrato_id
 WHERE (f.empresa_id=emp OR f.empresa_id IS NULL) AND (uni IS NULL OR f.estabelecimento_id IS NULL OR f.estabelecimento_id=uni)
   AND kidmais019_ocupa(r.fechamento_id) AND r.estado IN ('EM_ELABORACAO','CONGELADA')
   AND r.hold_destino_adquirido_em IS NOT NULL AND cf.versao_em_preparacao_id=r.contrato_versao_id
   AND cf.versao_vigente_id=r.versao_base_id AND r.data_evento BETWEEN inicio AND fim
 UNION ALL
 SELECT f.id,NULL::uuid,'PRE_RESERVA'::text,(a.inicio_evento AT TIME ZONE 'America/Sao_Paulo')::date,
        (a.inicio_evento AT TIME ZONE 'America/Sao_Paulo')::time,(a.fim_evento AT TIME ZONE 'America/Sao_Paulo')::time,
        a.empresa_id,a.estabelecimento_id,f.configuracao_agenda_id,a.salao_id
 FROM pre_reserva_recebimentos p
 JOIN pre_reserva_aceites a ON (a.empresa_id,a.fechamento_id,a.sequencia)=(p.empresa_id,p.fechamento_id,p.aceite_sequencia)
 JOIN fechamentos f ON f.id=p.fechamento_id
 WHERE (a.empresa_id=emp OR a.empresa_id IS NULL) AND (uni IS NULL OR a.estabelecimento_id IS NULL OR a.estabelecimento_id=uni)
   AND p.garantia_ate > statement_timestamp() AND p.encerramento IS NULL
   AND f.status NOT IN ('CANCELADO','RECUSADO','EXPIRADO') AND NOT kidmais019_ocupa(f.id)
   AND (a.inicio_evento AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN inicio AND fim;
END $$;

COMMIT;
