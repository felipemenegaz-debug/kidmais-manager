-- Rollback 061 — só antes de qualquer integração e só com a 062 fora (regras removidas). Nunca remove contrato,
-- festa ou financeiro integrados.
-- NÃO APLICADO. Exige autorização explícita (docs/OPERACAO_AGENTES.md).
-- Gerado offline por scripts/migration-061-manifest.mjs: restaura byte a byte kidmais019_formalizacao, kidmais_ocupacoes_operacionais, kidmais_validar_agenda_revisao (019)
-- mais kidmais_validar_fluxo_contrato (057) e kidmais_015_validar (015), e confere os hashes no fim.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = public, pg_catalog;
LOCK TABLE public.contrato_importacoes, public.contrato_importacao_financeiro, public.fechamentos, public.contratos,
  public.contrato_versoes, public.festas IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  -- Com as regras da 062 instaladas, restaurar os corpos da 019 apagaria o escopo por empresa/unidade e deixaria a 062
  -- apontando para funções da 061 removidas. Ordem obrigatória: rollback da 062 antes (o suave basta: remove as regras).
  IF to_regprocedure('public.kidmais062_ocupacoes_escopo(date,date)') IS NOT NULL THEN
    RAISE EXCEPTION 'Rollback 061 recusado: a 062 está aplicada; aplique antes o rollback da 062.';
  END IF;
  IF EXISTS(SELECT 1 FROM public.contrato_importacoes) OR EXISTS(SELECT 1 FROM public.contrato_importacao_financeiro)
     OR EXISTS(SELECT 1 FROM public.fechamentos WHERE origem_fechamento = 'IMPORTACAO_HISTORICA')
     OR EXISTS(SELECT 1 FROM public.contrato_versoes WHERE aceite_metodo = 'CONFERENCIA_PAPEL')
     OR EXISTS(SELECT 1 FROM public.festas WHERE origem_criacao = 'IMPORTACAO_HISTORICA') THEN
    RAISE EXCEPTION 'Rollback 061 recusado: há contratos históricos integrados; correção forward necessária.';
  END IF;
END $$;
DROP TRIGGER festa019_061_origem_importacao ON public.festas;
DROP TRIGGER fechamentos_061_vinculo_trg ON public.fechamentos;
DROP TRIGGER fechamentos_061_origem_trg ON public.fechamentos;
CREATE OR REPLACE FUNCTION public.kidmais019_formalizacao(cid uuid,vid uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = public, pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM contratos c JOIN contrato_fluxos cf ON cf.contrato_id=c.id
 JOIN contrato_versoes v ON v.id=cf.versao_vigente_id
 JOIN contrato_edicoes e ON e.contrato_versao_id=v.id
 JOIN contrato_documentos d ON d.id=e.documento_revisado_id
 JOIN contrato_assinaturas k ON k.contrato_versao_id=v.id AND k.parte='KIDMAIS'
 JOIN contrato_assinaturas a ON a.contrato_versao_id=v.id AND a.parte='CLIENTE'
 WHERE c.id=cid AND v.id=vid AND c.status='ASSINADO' AND c.cancelado_em IS NULL
 AND v.status='ASSINADA' AND e.estado='CONCLUIDA'
 AND k.documento_id=d.id AND a.documento_id=d.id AND d.contrato_versao_id=v.id
 AND k.snapshot_hash=v.snapshot_hash AND a.snapshot_hash=v.snapshot_hash AND d.snapshot_hash=v.snapshot_hash
 AND k.pdf_hash=d.pdf_hash AND a.pdf_hash=d.pdf_hash AND v.documento_pdf_hash=d.pdf_hash);
$$;
CREATE OR REPLACE FUNCTION public.kidmais_ocupacoes_operacionais(inicio date,fim date)
RETURNS TABLE(fechamento_id uuid,revisao_id uuid,origem text,data date,horario_inicio time,horario_fim time)
LANGUAGE sql STABLE AS $$
 SELECT f.id,NULL::uuid,'CONFIRMADA'::text,f.data_evento,f.horario_inicio,f.horario_fim
 FROM public.fechamentos f WHERE public.kidmais019_ocupa(f.id) AND f.data_evento BETWEEN inicio AND fim
 UNION ALL SELECT r.fechamento_id,r.id,'REVISAO_DESTINO'::text,r.data_evento,r.horario_inicio,r.horario_fim
 FROM public.fechamento_revisoes r JOIN public.contrato_fluxos cf ON cf.contrato_id=r.contrato_id
 WHERE public.kidmais019_ocupa(r.fechamento_id) AND r.estado IN ('EM_ELABORACAO','CONGELADA')
 AND r.hold_destino_adquirido_em IS NOT NULL AND cf.versao_em_preparacao_id=r.contrato_versao_id
 AND cf.versao_vigente_id=r.versao_base_id AND r.data_evento BETWEEN inicio AND fim;
$$;
CREATE OR REPLACE FUNCTION public.kidmais_validar_agenda_revisao() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r public.fechamento_revisoes%ROWTYPE; f public.fechamentos%ROWTYPE; target_day date; ini time; fim time; fid uuid;
BEGIN
 IF TG_TABLE_NAME='fechamentos' THEN
  SELECT * INTO f FROM public.fechamentos WHERE id=NEW.id;
  IF NOT public.kidmais019_ocupa(f.id) THEN RETURN NULL; END IF;
  target_day:=f.data_evento; ini:=f.horario_inicio; fim:=f.horario_fim; fid:=f.id;
 ELSE
  SELECT * INTO r FROM public.fechamento_revisoes WHERE id=NEW.id;
  SELECT * INTO f FROM public.fechamentos WHERE id=r.fechamento_id;
  IF r.estado='CANCELADA' THEN RETURN NULL; END IF;
  IF r.hold_destino_adquirido_em IS NOT NULL AND NOT public.kidmais019_ocupa(f.id) THEN RAISE EXCEPTION 'Hold exige reserva vigente confirmada' USING ERRCODE='23514'; END IF;
  -- A deferred event may observe the already-applied terminal row.
  IF r.hold_destino_adquirido_em IS NULL AND r.estado<>'APLICADA' THEN RETURN NULL; END IF;
  IF r.estado='APLICADA' AND public.kidmais019_ocupa(f.id) AND r.hold_destino_adquirido_em IS NULL THEN RAISE EXCEPTION 'Remarcação confirmada exige hold validado' USING ERRCODE='23514'; END IF;
  target_day:=r.data_evento; ini:=r.horario_inicio; fim:=r.horario_fim; fid:=r.fechamento_id;
 END IF;
 PERFORM public.kidmais_lock_datas_revisao(ARRAY[target_day]);
 IF EXISTS(SELECT 1 FROM public.kidmais_ocupacoes_operacionais(target_day,target_day) o WHERE o.fechamento_id<>fid AND o.horario_inicio<fim AND o.horario_fim>ini) OR EXISTS(SELECT 1 FROM public.bloqueios_agenda b WHERE b.ativo AND b.data=target_day AND (b.dia_inteiro OR b.horario_inicio IS NULL OR b.horario_fim IS NULL OR (b.horario_inicio<fim AND b.horario_fim>ini))) THEN RAISE EXCEPTION 'Conflito de agenda da revisão' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION public.kidmais_validar_fluxo_contrato() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cid uuid; vid uuid; v contrato_versoes%ROWTYPE; e contrato_edicoes%ROWTYPE;
 f contrato_fluxos%ROWTYPE; a contrato_assinaturas%ROWTYPE; d contrato_documentos%ROWTYPE;
 s sessoes_administrativas%ROWTYPE; u usuarios_administrativos%ROWTYPE; prova validacoes_identidade_cliente%ROWTYPE;
BEGIN
 IF TG_TABLE_NAME='contrato_fluxos' THEN
  cid:=NEW.contrato_id;
 ELSE
  IF TG_TABLE_NAME='contrato_versoes' THEN vid:=NEW.id; cid:=NEW.contrato_id;
  ELSE vid:=NEW.contrato_versao_id; SELECT contrato_id INTO cid FROM contrato_versoes WHERE id=vid; END IF;
 END IF;
 SELECT * INTO f FROM contrato_fluxos WHERE contrato_id=cid;
 IF f.contrato_id IS NULL THEN
  IF TG_TABLE_NAME='contrato_versoes' AND TG_OP='UPDATE' AND NOT EXISTS(SELECT 1 FROM contrato_edicoes WHERE contrato_versao_id=vid) THEN RETURN NULL; END IF;
  RAISE EXCEPTION 'Novo contrato exige fluxo explícito' USING ERRCODE='23514';
 END IF;
 IF f.versao_vigente_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM contrato_versoes WHERE id=f.versao_vigente_id AND contrato_id=cid AND status='ASSINADA') THEN RAISE EXCEPTION 'Vigência exige versão assinada' USING ERRCODE='23514'; END IF;
 IF TG_TABLE_NAME='contrato_fluxos' THEN
  IF TG_OP='UPDATE' THEN
   IF OLD.versao_vigente_id IS NOT NULL AND f.versao_vigente_id IS NULL THEN RAISE EXCEPTION 'Vigência não pode desaparecer' USING ERRCODE='23514'; END IF;
  END IF;
 END IF;
 IF f.versao_em_preparacao_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM contrato_edicoes ce JOIN contrato_versoes cv ON cv.id=ce.contrato_versao_id WHERE cv.id=f.versao_em_preparacao_id AND cv.status='ATIVA' AND ce.estado IN ('EM_ELABORACAO','ASSINADA_KIDMAIS','AGUARDANDO_CLIENTE')) THEN RAISE EXCEPTION 'Preparação inválida' USING ERRCODE='23514'; END IF;
 IF f.versao_vigente_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM contratos c JOIN contrato_versoes cv ON cv.id=f.versao_vigente_id WHERE c.id=cid AND c.versao_atual=cv.numero_versao AND c.status='ASSINADO') THEN RAISE EXCEPTION 'Ponteiro lógico diverge da vigência' USING ERRCODE='23514'; END IF;
 IF vid IS NOT NULL THEN
  SELECT * INTO v FROM contrato_versoes WHERE id=vid;
  SELECT * INTO e FROM contrato_edicoes WHERE contrato_versao_id=vid;
  IF e.contrato_versao_id IS NULL THEN RAISE EXCEPTION 'Nova versão exige edição' USING ERRCODE='23514'; END IF;
  IF e.origem_versao_id IS NOT NULL AND (v.motivo_nova_versao IS NULL OR btrim(v.motivo_nova_versao)='') THEN RAISE EXCEPTION 'Alteração exige motivo' USING ERRCODE='23514'; END IF;
  IF (e.estado='CONCLUIDA' AND v.status<>'ASSINADA') OR (e.estado='CANCELADA' AND v.status<>'CANCELADA') OR (e.estado NOT IN ('CONCLUIDA','CANCELADA') AND (v.status<>'ATIVA' OR f.versao_em_preparacao_id IS DISTINCT FROM vid)) THEN RAISE EXCEPTION 'Estado edição/versão inconsistente' USING ERRCODE='23514'; END IF;
  IF e.documento_revisado_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM contrato_documentos WHERE id=e.documento_revisado_id AND categoria='CONTRATO' AND revisao=e.revisao AND snapshot_hash=v.snapshot_hash) THEN RAISE EXCEPTION 'Documento revisado divergente' USING ERRCODE='23514'; END IF;
  SELECT * INTO a FROM contrato_assinaturas WHERE contrato_versao_id=vid AND parte='KIDMAIS';
  IF e.estado IN ('ASSINADA_KIDMAIS','AGUARDANDO_CLIENTE','CONCLUIDA') AND (a.id IS NULL OR e.revisao_comercial_aprovada IS DISTINCT FROM e.revisao OR e.documento_revisado_id IS DISTINCT FROM a.documento_id) THEN RAISE EXCEPTION 'Assinatura Kidmais/revisão ausente' USING ERRCODE='23514'; END IF;
  IF e.estado IN ('AGUARDANDO_CLIENTE','CONCLUIDA') AND e.liberado_em IS NULL THEN RAISE EXCEPTION 'Liberação ausente' USING ERRCODE='23514'; END IF;
  IF e.estado='CONCLUIDA' AND NOT EXISTS(SELECT 1 FROM contrato_assinaturas ca WHERE ca.contrato_versao_id=vid AND ca.parte='CLIENTE' AND ca.pdf_hash=v.documento_pdf_hash AND ca.assinado_em=v.assinado_em AND ca.documento_id=a.documento_id) THEN RAISE EXCEPTION 'Aceite cliente ausente/divergente' USING ERRCODE='23514'; END IF;
 END IF;
 IF TG_TABLE_NAME='contrato_assinaturas' THEN
  SELECT * INTO d FROM contrato_documentos WHERE id=NEW.documento_id;
  IF d.categoria<>'CONTRATO' OR d.snapshot_hash<>NEW.snapshot_hash OR d.pdf_hash<>NEW.pdf_hash OR v.snapshot_hash<>NEW.snapshot_hash OR e.documento_revisado_id IS DISTINCT FROM d.id THEN RAISE EXCEPTION 'Documento/prova divergente' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS(SELECT 1 FROM contrato_documentos WHERE id=NEW.comprovante_documento_id AND categoria='COMPROVANTE_ASSINATURA' AND snapshot_hash=NEW.snapshot_hash) THEN RAISE EXCEPTION 'Comprovante inválido' USING ERRCODE='23514'; END IF;
  IF NEW.parte='KIDMAIS' THEN
   SELECT * INTO u FROM usuarios_administrativos WHERE id=NEW.usuario_id FOR UPDATE;
   SELECT * INTO s FROM sessoes_administrativas WHERE id=NEW.sessao_id FOR UPDATE;
   IF u.id IS NULL OR NOT u.ativo OR NOT public.kidmais_057_pode_assinar_pela_empresa(u.id, vid) OR s.id IS NULL OR s.usuario_id<>u.id OR s.revogado_em IS NOT NULL OR s.expira_em<=clock_timestamp() OR s.ultima_atividade_em<=clock_timestamp()-interval '30 minutes' OR s.autenticado_em<clock_timestamp()-interval '5 minutes' OR NEW.autenticado_em<>s.autenticado_em OR NEW.identidade_snapshot->>'nome' IS DISTINCT FROM u.nome OR NEW.identidade_snapshot->>'cargo' IS DISTINCT FROM u.cargo THEN RAISE EXCEPTION 'Sessão/identidade de assinatura inválida' USING ERRCODE='23514'; END IF;
  ELSE
   SELECT * INTO prova FROM validacoes_identidade_cliente WHERE id=NEW.validacao_identidade_id;
   IF prova.id IS NULL OR prova.finalidade<>'CONTRATO_ACEITE' OR prova.status<>'CONSUMIDA' OR prova.consumido_por_contrato_versao_id IS DISTINCT FROM vid THEN RAISE EXCEPTION 'OTP inválido para assinatura' USING ERRCODE='23514'; END IF;
  END IF;
 END IF;
 RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION public.kidmais_015_validar() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE j jsonb:=to_jsonb(NEW); pid uuid; cid uuid; o bigint; l bigint; reservado bigint; r record;
BEGIN
 pid:=(j->>'pagamento_id')::uuid;
 IF pid IS NULL AND TG_TABLE_NAME='pagamentos' THEN pid:=NEW.id; END IF;
 IF pid IS NULL AND TG_TABLE_NAME='pagamento_parcelas' THEN SELECT pagamento_id INTO pid FROM pagamento_planos WHERE id=NEW.plano_id; END IF;
 IF pid IS NULL AND TG_TABLE_NAME IN ('pagamento_estornos','pagamento_recebimento_alocacoes') THEN SELECT pagamento_id INTO pid FROM pagamento_recebimentos WHERE id=NEW.recebimento_id; END IF;
 IF pid IS NULL AND j ? 'cronograma_id' THEN SELECT pagamento_id INTO pid FROM pagamento_cronogramas WHERE id=(j->>'cronograma_id')::uuid; END IF;
 IF pid IS NULL AND j ? 'devolucao_id' THEN SELECT pagamento_id INTO pid FROM pagamento_devolucoes WHERE id=(j->>'devolucao_id')::uuid; END IF;
 IF pid IS NULL AND j ? 'ajuste_id' THEN SELECT pagamento_id INTO pid FROM pagamento_ajustes_contratuais WHERE id=(j->>'ajuste_id')::uuid; END IF;
 IF pid IS NULL THEN RAISE EXCEPTION 'Contexto 015 ausente' USING ERRCODE='23514'; END IF;
 SELECT contrato_id INTO cid FROM pagamento_gestoes WHERE pagamento_id=pid;
 IF cid IS NULL AND TG_TABLE_NAME IN ('pagamentos','pagamento_parcelas','pagamento_recebimentos','pagamento_estornos','pagamento_recebimento_alocacoes') THEN RETURN NULL; END IF;
 PERFORM 1 FROM pagamentos WHERE id=pid FOR UPDATE;
 IF NOT EXISTS(SELECT 1 FROM pagamentos p JOIN contrato_versoes v ON v.id=p.contrato_versao_id WHERE p.id=pid AND v.contrato_id=cid) THEN RAISE EXCEPTION 'Gestão pertence a outro contrato' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM pagamento_tratamentos t JOIN contrato_pendencias_financeiras p ON p.id=t.pendencia_id WHERE t.pagamento_id=pid AND (p.pagamento_id<>pid OR p.contrato_id<>cid)) THEN RAISE EXCEPTION 'Pendência divergente' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM pagamento_eventos e LEFT JOIN pagamento_tratamentos t ON t.id=e.tratamento_id LEFT JOIN contrato_pendencias_financeiras p ON p.id=e.pendencia_id WHERE e.pagamento_id=pid AND ((t.id IS NOT NULL AND (t.pagamento_id<>pid OR t.pendencia_id IS DISTINCT FROM e.pendencia_id)) OR (p.id IS NOT NULL AND p.pagamento_id<>pid))) THEN RAISE EXCEPTION 'Evento em contexto divergente' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM pagamento_movimentos_contextos m JOIN pagamento_eventos e ON e.id=m.evento_id JOIN contrato_versoes v ON v.id=m.versao_financeira_id LEFT JOIN pagamento_recebimentos pr ON pr.id=m.recebimento_id LEFT JOIN pagamento_estornos s ON s.id=m.estorno_id LEFT JOIN pagamento_recebimentos sr ON sr.id=s.recebimento_id WHERE m.pagamento_id=pid AND (e.pagamento_id<>pid OR v.contrato_id<>cid OR coalesce(pr.pagamento_id,sr.pagamento_id)<>pid OR v.status<>'ASSINADA')) THEN RAISE EXCEPTION 'Autoria econômica divergente' USING ERRCODE='23514'; END IF;
 IF TG_TABLE_NAME='pagamento_ajustes_contratuais' THEN
  IF NOT EXISTS(SELECT 1 FROM contrato_fluxos WHERE contrato_id=cid AND versao_vigente_id=NEW.versao_reconhecida_id) THEN RAISE EXCEPTION 'Versão reconhecida não é vigente' USING ERRCODE='23514'; END IF;
 END IF;
 IF EXISTS(SELECT 1 FROM pagamento_ajuste_bases b JOIN pagamento_ajustes_contratuais a ON a.id=b.ajuste_id LEFT JOIN pagamento_recebimentos pr ON pr.id=b.recebimento_id LEFT JOIN pagamento_estornos e ON e.id=b.estorno_id LEFT JOIN pagamento_recebimentos er ON er.id=e.recebimento_id LEFT JOIN pagamento_devolucoes d ON d.id=b.devolucao_id WHERE a.pagamento_id=pid AND (coalesce(pr.pagamento_id,er.pagamento_id,d.pagamento_id)<>pid OR coalesce(pr.valor_bruto*100,e.valor*100,d.valor_centavos)<>b.valor_centavos OR coalesce(pr.status,e.status,d.estado) NOT IN ('CONFIRMADO','CONCLUIDA'))) THEN RAISE EXCEPTION 'Base histórica divergente' USING ERRCODE='23514'; END IF;
 IF (SELECT sequencia FROM pagamento_gestoes WHERE pagamento_id=pid)<>(SELECT coalesce(max(sequencia),0) FROM pagamento_eventos WHERE pagamento_id=pid) OR (SELECT count(*) FROM pagamento_eventos WHERE pagamento_id=pid)<>(SELECT sequencia FROM pagamento_gestoes WHERE pagamento_id=pid) THEN RAISE EXCEPTION 'Sequência sem evento' USING ERRCODE='23514'; END IF;
 FOR r IN SELECT a.*,v.snapshot,v.status AS vs,v.contrato_id AS vc,p.versao_nova_id,t.estado AS te,e.tipo,e.pagamento_id AS ep,e.sequencia AS es FROM pagamento_ajustes_contratuais a JOIN contrato_versoes v ON v.id=a.versao_reconhecida_id JOIN pagamento_tratamentos t ON t.id=a.tratamento_id JOIN contrato_pendencias_financeiras p ON p.id=t.pendencia_id JOIN pagamento_eventos e ON e.id=a.evento_id WHERE a.pagamento_id=pid LOOP
 IF r.vc<>cid OR r.vs<>'ASSINADA' OR r.versao_nova_id<>r.versao_reconhecida_id OR r.te<>'RESOLVIDA' OR r.tipo<>'ALTERACAO_RESOLVIDA' OR r.ep<>pid OR (r.snapshot->'comercial'->>'valorFinalContrato')::numeric*100<>r.obrigacao_depois_centavos THEN RAISE EXCEPTION 'Reconhecimento inconsistente' USING ERRCODE='23514'; END IF;
 IF r.ajuste_anterior_id IS NULL THEN
 IF NOT EXISTS(SELECT 1 FROM pagamentos WHERE id=pid AND contrato_versao_id=r.versao_base_financeira_id AND valor_total_contratado*100=r.obrigacao_antes_centavos) THEN RAISE EXCEPTION 'Base original divergente' USING ERRCODE='23514'; END IF;
 ELSIF NOT EXISTS(SELECT 1 FROM pagamento_ajustes_contratuais a JOIN pagamento_eventos ev ON ev.id=a.evento_id WHERE a.id=r.ajuste_anterior_id AND a.pagamento_id=pid AND a.versao_reconhecida_id=r.versao_base_financeira_id AND a.obrigacao_depois_centavos=r.obrigacao_antes_centavos AND ev.sequencia<r.es) THEN RAISE EXCEPTION 'Cadeia de ajustes inválida' USING ERRCODE='23514'; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pagamento_tratamentos t WHERE t.pagamento_id=pid AND t.estado='RESOLVIDA' AND NOT EXISTS(SELECT 1 FROM pagamento_ajustes_contratuais a WHERE a.tratamento_id=t.id)) THEN RAISE EXCEPTION 'Tratamento resolvido sem ajuste' USING ERRCODE='23514'; END IF;
 FOR r IN SELECT c.*,v.contrato_id AS vc,v.snapshot,e.pagamento_id AS ep,e.sequencia AS es FROM pagamento_cronogramas c JOIN contrato_versoes v ON v.id=c.versao_referencia_id JOIN pagamento_eventos e ON e.id=c.evento_id WHERE c.pagamento_id=pid LOOP
 IF r.vc<>cid OR r.ep<>pid OR (r.plano_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM pagamento_planos WHERE id=r.plano_id AND pagamento_id=pid)) OR r.saldo_inicial_centavos<>(SELECT coalesce(sum(saldo_inicial_centavos),0) FROM pagamento_cronograma_itens WHERE cronograma_id=r.id) THEN RAISE EXCEPTION 'Cronograma inconsistente' USING ERRCODE='23514'; END IF;
 IF r.cronograma_anterior_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM pagamento_cronogramas cr JOIN pagamento_eventos ev ON ev.id=cr.evento_id WHERE cr.id=r.cronograma_anterior_id AND cr.pagamento_id=pid AND ev.sequencia<r.es) THEN RAISE EXCEPTION 'Cadeia de cronogramas inválida' USING ERRCODE='23514'; END IF;
 IF r.ajuste_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM pagamento_ajustes_contratuais a WHERE a.id=r.ajuste_id AND a.pagamento_id=pid AND a.evento_id=r.evento_id AND a.versao_reconhecida_id=r.versao_referencia_id) THEN RAISE EXCEPTION 'Cronograma não corresponde ao ajuste' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM pagamento_cronograma_itens i JOIN pagamento_parcelas p ON p.id=i.parcela_id JOIN pagamento_planos pl ON pl.id=p.plano_id WHERE i.cronograma_id=r.id AND (pl.pagamento_id<>pid OR p.vencimento<>i.vencimento_referencia OR i.saldo_inicial_centavos>p.valor_previsto*100 OR (coalesce(r.snapshot->'comercial'->'condicaoPagamento'->>'forma',r.snapshot->'comercial'->>'formaPagamentoPretendida')='PIX_PARCELADO' AND i.vencimento_referencia>r.data_festa_referencia))) THEN RAISE EXCEPTION 'Item incompatível com cronograma' USING ERRCODE='23514'; END IF;
 END LOOP;
 FOR r IN SELECT d.*,cr.estado AS re,cr.valor_centavos AS rv,cr.pagamento_id AS rp FROM pagamento_devolucoes d JOIN pagamento_credito_reservas cr ON cr.id=d.reserva_id WHERE d.pagamento_id=pid LOOP
 IF r.rp<>pid OR r.rv<>r.valor_centavos OR r.re<>(CASE r.estado WHEN 'PENDENTE' THEN 'ATIVA' WHEN 'CONCLUIDA' THEN 'CONSUMIDA' ELSE 'LIBERADA' END) OR r.valor_centavos<>(SELECT coalesce(sum(valor_centavos),0) FROM pagamento_devolucao_alocacoes WHERE devolucao_id=r.id) THEN RAISE EXCEPTION 'Devolução/reserva divergente' USING ERRCODE='23514'; END IF;
 IF r.estado='CONCLUIDA' AND (NOT EXISTS(SELECT 1 FROM pagamento_eventos e WHERE e.id=r.evento_conclusao_id AND e.pagamento_id=pid AND e.tipo='DEVOLUCAO_CONCLUIDA' AND e.identidade_snapshot->>'papel'='REPRESENTANTE_AUTORIZADO') OR (NOT EXISTS(SELECT 1 FROM pagamento_devolucao_comprovantes WHERE devolucao_id=r.id) AND coalesce(length(btrim(r.justificativa_sem_comprovante)),0)=0)) THEN RAISE EXCEPTION 'Conclusão sem representante/evidência' USING ERRCODE='23514'; END IF;
 IF r.referencia_externa IS NOT NULL AND EXISTS(SELECT 1 FROM pagamento_estornos WHERE provedor_codigo=r.provedor_codigo AND referencia_externa=r.referencia_externa) THEN RAISE EXCEPTION 'Saída registrada também como estorno' USING ERRCODE='23514'; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pagamento_credito_reservas cr WHERE cr.pagamento_id=pid AND NOT EXISTS(SELECT 1 FROM pagamento_devolucoes d WHERE d.reserva_id=cr.id)) THEN RAISE EXCEPTION 'Reserva sem devolução' USING ERRCODE='23514'; END IF;
 FOR r IN SELECT a.id,a.valor_alocado,a.recebimento_id,a.parcela_id FROM pagamento_recebimento_alocacoes a JOIN pagamento_recebimentos pr ON pr.id=a.recebimento_id WHERE pr.pagamento_id=pid LOOP
 IF r.valor_alocado*100 < (SELECT coalesce(sum(valor),0)*100 FROM pagamento_estornos WHERE recebimento_id=r.recebimento_id AND parcela_id=r.parcela_id AND status IN ('SOLICITADO','CONFIRMADO')) + (SELECT coalesce(sum(da.valor_centavos),0) FROM pagamento_devolucao_alocacoes da JOIN pagamento_devolucoes d ON d.id=da.devolucao_id WHERE da.recebimento_alocacao_id=r.id AND d.estado IN ('PENDENTE','CONCLUIDA')) THEN RAISE EXCEPTION 'Origem financeira comprometida' USING ERRCODE='23514'; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pagamento_devolucao_alocacoes da JOIN pagamento_devolucoes d ON d.id=da.devolucao_id JOIN pagamento_recebimento_alocacoes a ON a.id=da.recebimento_alocacao_id JOIN pagamento_recebimentos pr ON pr.id=a.recebimento_id WHERE d.pagamento_id=pid AND (pr.pagamento_id<>pid OR pr.status<>'CONFIRMADO')) THEN RAISE EXCEPTION 'Origem de devolução inválida' USING ERRCODE='23514'; END IF;
 SELECT valor_total_contratado*100 INTO o FROM pagamentos WHERE id=pid;
 o:=o+(SELECT coalesce(sum(delta_centavos),0) FROM pagamento_ajustes_contratuais WHERE pagamento_id=pid);
 SELECT coalesce(sum(valor_bruto),0)*100 INTO l FROM pagamento_recebimentos WHERE pagamento_id=pid AND status='CONFIRMADO';
 l:=l-(SELECT coalesce(sum(e.valor),0)*100 FROM pagamento_estornos e JOIN pagamento_recebimentos pr ON pr.id=e.recebimento_id WHERE pr.pagamento_id=pid AND e.status='CONFIRMADO')-(SELECT coalesce(sum(valor_centavos),0) FROM pagamento_devolucoes WHERE pagamento_id=pid AND estado='CONCLUIDA');
 SELECT coalesce(sum(valor_centavos),0) INTO reservado FROM pagamento_credito_reservas WHERE pagamento_id=pid AND estado='ATIVA';
 IF o<0 OR l<0 OR reservado>greatest(l-o,0) THEN RAISE EXCEPTION 'Posição econômica/reserva inválida' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM pagamento_ajustes_contratuais WHERE pagamento_id=pid) AND NOT EXISTS(SELECT 1 FROM pagamento_cronogramas WHERE pagamento_id=pid AND estado='ATIVO') THEN RAISE EXCEPTION 'Regularização sem cronograma canônico' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM pagamento_cronogramas WHERE pagamento_id=pid AND estado='ATIVO') AND
 (SELECT coalesce(sum(greatest(i.saldo_inicial_centavos+i.recebido_base_centavos-i.estornado_base_centavos
 -coalesce((SELECT sum(al.valor_alocado)*100 FROM pagamento_recebimento_alocacoes al JOIN pagamento_recebimentos pr ON pr.id=al.recebimento_id WHERE al.parcela_id=i.parcela_id AND pr.status='CONFIRMADO'),0)
 +coalesce((SELECT sum(es.valor)*100 FROM pagamento_estornos es WHERE es.parcela_id=i.parcela_id AND es.status='CONFIRMADO'),0),0)),0)
 FROM pagamento_cronograma_itens i JOIN pagamento_cronogramas cr ON cr.id=i.cronograma_id WHERE cr.pagamento_id=pid AND cr.estado='ATIVO')<>greatest(o-l,0)
 THEN RAISE EXCEPTION 'Saldo econômico exige cronograma com cobertura exata' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
DROP TABLE public.contrato_importacao_financeiro;
DROP TABLE public.contrato_importacoes;
DROP FUNCTION public.kidmais061_historico_passado(uuid);
DROP FUNCTION public.kidmais061_excecao_historica(uuid, date);
DROP FUNCTION public.kidmais061_conferencia_historica(uuid, uuid);
DROP FUNCTION public.kidmais061_exigir_vinculo();
DROP FUNCTION public.kidmais061_origem_fechamento();
DROP FUNCTION public.kidmais061_validar_financeiro();
DROP FUNCTION public.kidmais061_validar_vinculo();
DROP FUNCTION public.kidmais061_imutavel();
ALTER TABLE public.festas DROP CONSTRAINT festa019_autoria_check,
  ADD CONSTRAINT festa019_autoria_check CHECK (
 (origem_criacao='MANUAL_HISTORICA' AND criado_por IS NOT NULL) OR
 (origem_criacao='AUTOMATICA_FORMALIZACAO' AND criado_por IS NULL));
ALTER TABLE public.contrato_versoes DROP CONSTRAINT contrato_versoes_assinatura_documento_check,
  ADD CONSTRAINT contrato_versoes_assinatura_documento_check CHECK (
    status <> 'ASSINADA' OR (documento_template_versao IS NOT NULL AND documento_pdf_hash IS NOT NULL AND aceite_metodo IS NOT NULL)),
  DROP CONSTRAINT contrato_versoes_aceite_metodo_check,
  ADD CONSTRAINT contrato_versoes_aceite_metodo_check CHECK (aceite_metodo IS NULL OR aceite_metodo IN ('OTP'));
ALTER TABLE public.fechamentos DROP CONSTRAINT fechamentos_origem_check,
  ADD CONSTRAINT fechamentos_origem_check CHECK (origem_fechamento IN ('CLIENTE', 'ATENDIMENTO_KIDMAIS'));
DO $$ BEGIN
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = 'public.kidmais_validar_fluxo_contrato()'::regprocedure) IS DISTINCT FROM 'e7d4d19ac1b1d925135adbc45a2247a5'
     OR (SELECT encode(sha256(convert_to(replace(prosrc, E'\r', ''), 'UTF8')), 'hex') FROM pg_proc WHERE oid = 'public.kidmais019_formalizacao(uuid,uuid)'::regprocedure) IS DISTINCT FROM 'ef21416cd23e5a2d59c486abc83470ca47dc30a2ef8501b488d216c88804fa25'
     OR (SELECT encode(sha256(convert_to(replace(prosrc, E'\r', ''), 'UTF8')), 'hex') FROM pg_proc WHERE oid = 'public.kidmais_ocupacoes_operacionais(date,date)'::regprocedure) IS DISTINCT FROM '2257c1df5a299a86d60a59b8606e432715dd10d713e4659f370934dcf483be91'
     OR (SELECT encode(sha256(convert_to(replace(prosrc, E'\r', ''), 'UTF8')), 'hex') FROM pg_proc WHERE oid = 'public.kidmais_validar_agenda_revisao()'::regprocedure) IS DISTINCT FROM '997158485f6dc9595cf6045594b220206c59c31b631bc164aad3956963875e89'
     OR (SELECT encode(sha256(convert_to(replace(prosrc, E'\r', ''), 'UTF8')), 'hex') FROM pg_proc WHERE oid = 'public.kidmais_015_validar()'::regprocedure) IS DISTINCT FROM 'f003f5f39c136b98aa3d1784584b1dca8fd6aca9fd665dc7351d3044e6f6e06c'
     OR (SELECT encode(sha256(convert_to(replace(prosrc, E'\r', ''), 'UTF8')), 'hex') FROM pg_proc WHERE oid = 'public.kidmais019_ocupa(uuid)'::regprocedure) IS DISTINCT FROM '87131946b52479651484ec9076ce264243e79867ab2bc1f02447c6a2eb0599a3' THEN
    RAISE EXCEPTION 'Rollback 061: corpos restaurados divergem de 019/057/015.';
  END IF;
END $$;
COMMIT;
