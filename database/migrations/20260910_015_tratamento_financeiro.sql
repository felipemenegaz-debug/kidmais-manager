-- 015: reconhecimento financeiro explícito. Zero backfill. Aplicação coordenada com código compatível.
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $$ BEGIN
 IF to_regclass('contrato_pendencias_financeiras') IS NULL OR to_regclass('fechamento_revisoes') IS NULL THEN RAISE EXCEPTION '015 exige 013/014'; END IF;
 IF to_regclass('pagamento_gestoes') IS NOT NULL THEN RAISE EXCEPTION '015 já existe; executar postcheck'; END IF;
END $$;

CREATE TABLE pagamento_gestoes (
 pagamento_id uuid PRIMARY KEY REFERENCES pagamentos ON UPDATE RESTRICT ON DELETE RESTRICT,
 contrato_id uuid NOT NULL UNIQUE REFERENCES contratos ON UPDATE RESTRICT ON DELETE RESTRICT,
 sequencia bigint NOT NULL DEFAULT 0 CHECK(sequencia>=0), criado_em timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE pagamento_tratamentos (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), pendencia_id uuid NOT NULL REFERENCES contrato_pendencias_financeiras ON UPDATE RESTRICT ON DELETE RESTRICT,
 pagamento_id uuid NOT NULL REFERENCES pagamento_gestoes ON UPDATE RESTRICT ON DELETE RESTRICT,
 tentativa integer NOT NULL CHECK(tentativa>0), estado varchar(20) NOT NULL CHECK(estado IN ('EM_TRATAMENTO','RESOLVIDA','CANCELADA','SUPERADA')),
 posicao_base_hash char(64) NOT NULL CHECK(posicao_base_hash ~ '^[0-9a-f]{64}$'),
 iniciado_por_usuario_id uuid NOT NULL REFERENCES usuarios_administrativos ON UPDATE RESTRICT ON DELETE RESTRICT,
 iniciado_em timestamptz NOT NULL DEFAULT clock_timestamp(), encerrado_em timestamptz, motivo_encerramento text,
 UNIQUE(pendencia_id,tentativa), CHECK((estado='EM_TRATAMENTO')=(encerrado_em IS NULL)),
 CHECK(estado NOT IN ('CANCELADA','SUPERADA') OR coalesce(length(btrim(motivo_encerramento)),0)>0)
);
CREATE UNIQUE INDEX p015_tratamento_aberto_uk ON pagamento_tratamentos(pendencia_id) WHERE estado='EM_TRATAMENTO';
CREATE UNIQUE INDEX p015_tratamento_resolvido_uk ON pagamento_tratamentos(pendencia_id) WHERE estado='RESOLVIDA';
CREATE TABLE pagamento_eventos (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), pagamento_id uuid NOT NULL REFERENCES pagamento_gestoes ON UPDATE RESTRICT ON DELETE RESTRICT,
 sequencia bigint NOT NULL CHECK(sequencia>0), pendencia_id uuid REFERENCES contrato_pendencias_financeiras ON UPDATE RESTRICT ON DELETE RESTRICT,
 tratamento_id uuid REFERENCES pagamento_tratamentos ON UPDATE RESTRICT ON DELETE RESTRICT,
 tipo varchar(40) NOT NULL CHECK(tipo IN ('TRATAMENTO_INICIADO','TRATAMENTO_CANCELADO','PENDENCIA_SUPERADA','ALTERACAO_RESOLVIDA','CRONOGRAMA_REPROGRAMADO','RECEBIMENTO_REGISTRADO','RECEBIMENTO_CONFIRMADO','ESTORNO_SOLICITADO','ESTORNO_CONFIRMADO','DEVOLUCAO_SOLICITADA','DEVOLUCAO_CANCELADA','DEVOLUCAO_CONCLUIDA','COMPROVANTE_DEVOLUCAO_ANEXADO')),
 chave_idempotencia uuid NOT NULL, pedido_hash char(64) NOT NULL CHECK(pedido_hash ~ '^[0-9a-f]{64}$'),
 usuario_id uuid REFERENCES usuarios_administrativos ON UPDATE RESTRICT ON DELETE RESTRICT,
 ator_tipo varchar(16) NOT NULL CHECK(ator_tipo IN ('USUARIO','SISTEMA')),
 identidade_snapshot jsonb NOT NULL CHECK(jsonb_typeof(identidade_snapshot)='object'), request_id uuid NOT NULL,
 sessao_id uuid, ip inet, user_agent text, justificativa text,
 dados_antes jsonb NOT NULL CHECK(jsonb_typeof(dados_antes)='object'), dados_depois jsonb NOT NULL CHECK(jsonb_typeof(dados_depois)='object'),
 resultado jsonb NOT NULL CHECK(jsonb_typeof(resultado)='object'), criado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(pagamento_id,sequencia), UNIQUE(pagamento_id,chave_idempotencia),
 CHECK((ator_tipo='USUARIO' AND usuario_id IS NOT NULL) OR (ator_tipo='SISTEMA' AND usuario_id IS NULL AND tipo='PENDENCIA_SUPERADA')),
 CHECK(tipo<>'DEVOLUCAO_CONCLUIDA' OR coalesce(identidade_snapshot->>'papel'='REPRESENTANTE_AUTORIZADO',false))
);
CREATE INDEX p015_eventos_tempo_idx ON pagamento_eventos(pagamento_id,criado_em,id);
CREATE TABLE pagamento_ajustes_contratuais (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), pagamento_id uuid NOT NULL REFERENCES pagamento_gestoes ON UPDATE RESTRICT ON DELETE RESTRICT,
 tratamento_id uuid NOT NULL UNIQUE REFERENCES pagamento_tratamentos ON UPDATE RESTRICT ON DELETE RESTRICT,
 evento_id uuid NOT NULL UNIQUE REFERENCES pagamento_eventos ON UPDATE RESTRICT ON DELETE RESTRICT,
 ajuste_anterior_id uuid UNIQUE REFERENCES pagamento_ajustes_contratuais ON UPDATE RESTRICT ON DELETE RESTRICT,
 versao_base_financeira_id uuid NOT NULL REFERENCES contrato_versoes ON UPDATE RESTRICT ON DELETE RESTRICT,
 versao_reconhecida_id uuid NOT NULL REFERENCES contrato_versoes ON UPDATE RESTRICT ON DELETE RESTRICT,
 obrigacao_antes_centavos bigint NOT NULL CHECK(obrigacao_antes_centavos BETWEEN 1 AND 999999999999),
 delta_centavos bigint NOT NULL CHECK(delta_centavos BETWEEN -999999999999 AND 999999999999),
 obrigacao_depois_centavos bigint NOT NULL CHECK(obrigacao_depois_centavos BETWEEN 1 AND 999999999999),
 credito_aproveitado_centavos bigint NOT NULL DEFAULT 0 CHECK(credito_aproveitado_centavos BETWEEN 0 AND 999999999999),
 tratamento_saldo varchar(32) NOT NULL CHECK(tratamento_saldo IN ('REPROGRAMAR','MANTER_E_COMPLEMENTAR','PERSONALIZADO','SEM_SALDO')),
 decisao_contratante varchar(40) NOT NULL CHECK(decisao_contratante IN ('NAO_SE_APLICA','MANTER_APROVEITAMENTO','APROVEITAMENTO_AUTORIZADO','DEVOLUCAO_AO_PAGADOR_ANTERIOR')),
 justificativa text, criado_em timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(pagamento_id,versao_reconhecida_id),
 CHECK(obrigacao_depois_centavos=obrigacao_antes_centavos+delta_centavos)
);
CREATE UNIQUE INDEX p015_ajuste_raiz_uk ON pagamento_ajustes_contratuais(pagamento_id) WHERE ajuste_anterior_id IS NULL;
CREATE TABLE pagamento_cronogramas (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), pagamento_id uuid NOT NULL REFERENCES pagamento_gestoes ON UPDATE RESTRICT ON DELETE RESTRICT,
 evento_id uuid NOT NULL REFERENCES pagamento_eventos ON UPDATE RESTRICT ON DELETE RESTRICT,
 ajuste_id uuid REFERENCES pagamento_ajustes_contratuais ON UPDATE RESTRICT ON DELETE RESTRICT,
 cronograma_anterior_id uuid REFERENCES pagamento_cronogramas ON UPDATE RESTRICT ON DELETE RESTRICT,
 plano_id uuid UNIQUE REFERENCES pagamento_planos ON UPDATE RESTRICT ON DELETE RESTRICT,
 versao_referencia_id uuid NOT NULL REFERENCES contrato_versoes ON UPDATE RESTRICT ON DELETE RESTRICT,
 estado varchar(16) NOT NULL CHECK(estado IN ('ATIVO','SUBSTITUIDO')),
 modo varchar(32) NOT NULL CHECK(modo IN ('REPROGRAMAR','MANTER_E_COMPLEMENTAR','PERSONALIZADO','SEM_SALDO')),
 saldo_inicial_centavos bigint NOT NULL CHECK(saldo_inicial_centavos BETWEEN 0 AND 999999999999),
 data_festa_referencia date NOT NULL, criado_em timestamptz NOT NULL DEFAULT clock_timestamp(), substituido_em timestamptz,
 CHECK((estado='ATIVO')=(substituido_em IS NULL)), CHECK(saldo_inicial_centavos<>0 OR plano_id IS NULL)
);
CREATE UNIQUE INDEX p015_cronograma_ativo_uk ON pagamento_cronogramas(pagamento_id) WHERE estado='ATIVO';
CREATE TABLE pagamento_cronograma_itens (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), cronograma_id uuid NOT NULL REFERENCES pagamento_cronogramas ON UPDATE RESTRICT ON DELETE RESTRICT,
 parcela_id uuid NOT NULL REFERENCES pagamento_parcelas ON UPDATE RESTRICT ON DELETE RESTRICT,
 item_anterior_id uuid REFERENCES pagamento_cronograma_itens ON UPDATE RESTRICT ON DELETE RESTRICT,
 ordem smallint NOT NULL CHECK(ordem BETWEEN 1 AND 60), origem varchar(24) NOT NULL CHECK(origem IN ('PRESERVADA','REPROGRAMADA','COMPLEMENTO')),
 saldo_inicial_centavos bigint NOT NULL CHECK(saldo_inicial_centavos BETWEEN 1 AND 999999999999),
 recebido_base_centavos bigint NOT NULL CHECK(recebido_base_centavos BETWEEN 0 AND 999999999999),
 estornado_base_centavos bigint NOT NULL CHECK(estornado_base_centavos BETWEEN 0 AND 999999999999),
 vencimento_referencia date NOT NULL, UNIQUE(cronograma_id,ordem), UNIQUE(cronograma_id,parcela_id)
);
CREATE TABLE pagamento_movimentos_contextos (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), pagamento_id uuid NOT NULL REFERENCES pagamento_gestoes ON UPDATE RESTRICT ON DELETE RESTRICT,
 recebimento_id uuid UNIQUE REFERENCES pagamento_recebimentos ON UPDATE RESTRICT ON DELETE RESTRICT,
 estorno_id uuid UNIQUE REFERENCES pagamento_estornos ON UPDATE RESTRICT ON DELETE RESTRICT,
 evento_id uuid NOT NULL REFERENCES pagamento_eventos ON UPDATE RESTRICT ON DELETE RESTRICT,
 versao_financeira_id uuid NOT NULL REFERENCES contrato_versoes ON UPDATE RESTRICT ON DELETE RESTRICT,
 pagador_cliente_id uuid REFERENCES clientes ON UPDATE RESTRICT ON DELETE RESTRICT,
 identidade_economica_snapshot jsonb NOT NULL CHECK(jsonb_typeof(identidade_economica_snapshot)='object'),
 criado_em timestamptz NOT NULL DEFAULT clock_timestamp(), CHECK(num_nonnulls(recebimento_id,estorno_id)=1)
);
CREATE TABLE pagamento_credito_reservas (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), pagamento_id uuid NOT NULL REFERENCES pagamento_gestoes ON UPDATE RESTRICT ON DELETE RESTRICT,
 evento_criacao_id uuid NOT NULL REFERENCES pagamento_eventos ON UPDATE RESTRICT ON DELETE RESTRICT,
 evento_encerramento_id uuid REFERENCES pagamento_eventos ON UPDATE RESTRICT ON DELETE RESTRICT,
 valor_centavos bigint NOT NULL CHECK(valor_centavos BETWEEN 1 AND 999999999999), estado varchar(16) NOT NULL CHECK(estado IN ('ATIVA','LIBERADA','CONSUMIDA')),
 criado_em timestamptz NOT NULL DEFAULT clock_timestamp(), encerrado_em timestamptz,
 CHECK((estado='ATIVA' AND encerrado_em IS NULL AND evento_encerramento_id IS NULL) OR (estado<>'ATIVA' AND encerrado_em IS NOT NULL AND evento_encerramento_id IS NOT NULL))
);
CREATE INDEX p015_reserva_ativa_idx ON pagamento_credito_reservas(pagamento_id) WHERE estado='ATIVA';
CREATE TABLE pagamento_devolucoes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), pagamento_id uuid NOT NULL REFERENCES pagamento_gestoes ON UPDATE RESTRICT ON DELETE RESTRICT,
 reserva_id uuid NOT NULL UNIQUE REFERENCES pagamento_credito_reservas ON UPDATE RESTRICT ON DELETE RESTRICT,
 evento_solicitacao_id uuid NOT NULL REFERENCES pagamento_eventos ON UPDATE RESTRICT ON DELETE RESTRICT,
 evento_conclusao_id uuid REFERENCES pagamento_eventos ON UPDATE RESTRICT ON DELETE RESTRICT,
 evento_cancelamento_id uuid REFERENCES pagamento_eventos ON UPDATE RESTRICT ON DELETE RESTRICT,
 estado varchar(16) NOT NULL CHECK(estado IN ('PENDENTE','CONCLUIDA','CANCELADA')),
 valor_centavos bigint NOT NULL CHECK(valor_centavos BETWEEN 1 AND 999999999999),
 beneficiario_cliente_id uuid REFERENCES clientes ON UPDATE RESTRICT ON DELETE RESTRICT,
 beneficiario_snapshot jsonb NOT NULL CHECK(jsonb_typeof(beneficiario_snapshot)='object'), motivo text NOT NULL CHECK(btrim(motivo)<>''),
 devolvido_em timestamptz, meio_devolucao varchar(20) CHECK(meio_devolucao IN ('PIX','CARTAO','TRANSFERENCIA','DINHEIRO','OUTRO')),
 provedor_codigo varchar(50), referencia_externa varchar(160), observacao_execucao text, justificativa_sem_comprovante text,
 criado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((estado='CONCLUIDA')=(evento_conclusao_id IS NOT NULL)), CHECK((estado='CANCELADA')=(evento_cancelamento_id IS NOT NULL)),
 CHECK(estado<>'CONCLUIDA' OR (devolvido_em IS NOT NULL AND meio_devolucao IS NOT NULL AND coalesce(length(btrim(observacao_execucao)),0)>0)),
 CHECK(referencia_externa IS NULL OR coalesce(length(btrim(provedor_codigo)),0)>0)
);
CREATE UNIQUE INDEX p015_devolucao_provedor_uk ON pagamento_devolucoes(provedor_codigo,referencia_externa) WHERE provedor_codigo IS NOT NULL AND referencia_externa IS NOT NULL;
CREATE TABLE pagamento_devolucao_alocacoes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), devolucao_id uuid NOT NULL REFERENCES pagamento_devolucoes ON UPDATE RESTRICT ON DELETE RESTRICT,
 recebimento_alocacao_id uuid NOT NULL REFERENCES pagamento_recebimento_alocacoes ON UPDATE RESTRICT ON DELETE RESTRICT,
 valor_centavos bigint NOT NULL CHECK(valor_centavos BETWEEN 1 AND 999999999999), UNIQUE(devolucao_id,recebimento_alocacao_id)
);
CREATE TABLE pagamento_devolucao_comprovantes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), devolucao_id uuid NOT NULL REFERENCES pagamento_devolucoes ON UPDATE RESTRICT ON DELETE RESTRICT,
 evento_id uuid NOT NULL REFERENCES pagamento_eventos ON UPDATE RESTRICT ON DELETE RESTRICT,
 nome_arquivo varchar(255) NOT NULL CHECK(btrim(nome_arquivo)<>''), mime_type varchar(120) NOT NULL CHECK(mime_type IN ('application/pdf','image/jpeg','image/png')),
 tamanho_bytes bigint NOT NULL CHECK(tamanho_bytes BETWEEN 1 AND 10485760), sha256 char(64) NOT NULL,
 conteudo bytea NOT NULL, criado_em timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(devolucao_id,sha256),
 CHECK(tamanho_bytes=octet_length(conteudo)), CHECK(sha256=encode(sha256(conteudo),'hex'))
);
CREATE TABLE pagamento_ajuste_bases (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), ajuste_id uuid NOT NULL REFERENCES pagamento_ajustes_contratuais ON UPDATE RESTRICT ON DELETE RESTRICT,
 recebimento_id uuid REFERENCES pagamento_recebimentos ON UPDATE RESTRICT ON DELETE RESTRICT,
 estorno_id uuid REFERENCES pagamento_estornos ON UPDATE RESTRICT ON DELETE RESTRICT,
 devolucao_id uuid REFERENCES pagamento_devolucoes ON UPDATE RESTRICT ON DELETE RESTRICT,
 valor_centavos bigint NOT NULL CHECK(valor_centavos BETWEEN 1 AND 999999999999), fato_em timestamptz NOT NULL,
 CHECK(num_nonnulls(recebimento_id,estorno_id,devolucao_id)=1), UNIQUE(ajuste_id,recebimento_id), UNIQUE(ajuste_id,estorno_id), UNIQUE(ajuste_id,devolucao_id)
);

-- Índices das FKs novas (sem reindexar nem atualizar tabelas legadas).
DO $$ DECLARE r record; BEGIN
 FOR r IN SELECT c.conrelid::regclass AS tabela,a.attname FROM pg_constraint c JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=c.conkey[1]
 WHERE c.contype='f' AND c.conrelid IN ('pagamento_gestoes'::regclass,'pagamento_tratamentos'::regclass,'pagamento_eventos'::regclass,'pagamento_ajustes_contratuais'::regclass,'pagamento_cronogramas'::regclass,'pagamento_cronograma_itens'::regclass,'pagamento_movimentos_contextos'::regclass,'pagamento_credito_reservas'::regclass,'pagamento_devolucoes'::regclass,'pagamento_devolucao_alocacoes'::regclass,'pagamento_devolucao_comprovantes'::regclass,'pagamento_ajuste_bases'::regclass)
 LOOP EXECUTE format('CREATE INDEX ON %s (%I)',r.tabela,r.attname); END LOOP;
END $$;

CREATE FUNCTION kidmais_015_imutavel() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Fato financeiro imutável: %',TG_TABLE_NAME USING ERRCODE='23514'; END $$;
CREATE FUNCTION kidmais_015_processo() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Processo financeiro não pode ser apagado' USING ERRCODE='23514'; END IF;
 IF TG_TABLE_NAME='pagamento_gestoes' THEN
  IF (to_jsonb(NEW)-'sequencia') IS DISTINCT FROM (to_jsonb(OLD)-'sequencia') OR NEW.sequencia<>OLD.sequencia+1 THEN RAISE EXCEPTION 'Sequência inválida' USING ERRCODE='23514'; END IF;
 ELSIF TG_TABLE_NAME='pagamento_tratamentos' THEN
  IF OLD.estado<>'EM_TRATAMENTO' OR NEW.estado='EM_TRATAMENTO' OR (to_jsonb(NEW)-ARRAY['estado','encerrado_em','motivo_encerramento']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['estado','encerrado_em','motivo_encerramento']) THEN RAISE EXCEPTION 'Transição de tratamento inválida' USING ERRCODE='23514'; END IF;
 ELSIF TG_TABLE_NAME='pagamento_cronogramas' THEN
  IF OLD.estado<>'ATIVO' OR NEW.estado<>'SUBSTITUIDO' OR (to_jsonb(NEW)-ARRAY['estado','substituido_em']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['estado','substituido_em']) THEN RAISE EXCEPTION 'Cronograma imutável' USING ERRCODE='23514'; END IF;
 ELSIF TG_TABLE_NAME='pagamento_credito_reservas' THEN
  IF OLD.estado<>'ATIVA' OR NEW.estado='ATIVA' OR (to_jsonb(NEW)-ARRAY['estado','encerrado_em','evento_encerramento_id']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['estado','encerrado_em','evento_encerramento_id']) THEN RAISE EXCEPTION 'Reserva imutável' USING ERRCODE='23514'; END IF;
 ELSIF TG_TABLE_NAME='pagamento_devolucoes' THEN
  IF OLD.estado<>'PENDENTE' OR NEW.estado='PENDENTE' OR (to_jsonb(NEW)-ARRAY['estado','evento_conclusao_id','evento_cancelamento_id','devolvido_em','meio_devolucao','provedor_codigo','referencia_externa','observacao_execucao','justificativa_sem_comprovante']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['estado','evento_conclusao_id','evento_cancelamento_id','devolvido_em','meio_devolucao','provedor_codigo','referencia_externa','observacao_execucao','justificativa_sem_comprovante']) THEN RAISE EXCEPTION 'Devolução imutável' USING ERRCODE='23514'; END IF;
 END IF; RETURN NEW;
END $$;

CREATE FUNCTION kidmais_015_proteger_legado() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pid uuid; BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Histórico financeiro não pode ser apagado' USING ERRCODE='23514'; END IF;
 IF TG_TABLE_NAME='pagamentos' THEN
  IF NEW.contrato_versao_id<>OLD.contrato_versao_id OR NEW.valor_total_contratado<>OLD.valor_total_contratado OR NEW.moeda<>OLD.moeda THEN RAISE EXCEPTION 'Obrigação original imutável' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM pagamento_ajustes_contratuais WHERE pagamento_id=OLD.id) AND ROW(NEW.status,NEW.quitado_em) IS DISTINCT FROM ROW(OLD.status,OLD.quitado_em) THEN RAISE EXCEPTION 'Situação original preservada após regularização' USING ERRCODE='23514'; END IF;
 ELSIF TG_TABLE_NAME='pagamento_recebimentos' THEN
  IF OLD.status='CONFIRMADO' THEN RAISE EXCEPTION 'Recebimento confirmado imutável' USING ERRCODE='23514'; END IF;
 ELSIF TG_TABLE_NAME='pagamento_estornos' THEN
  IF OLD.status='CONFIRMADO' THEN RAISE EXCEPTION 'Estorno confirmado imutável' USING ERRCODE='23514'; END IF;
 ELSIF TG_TABLE_NAME='pagamento_parcelas' THEN
  IF (to_jsonb(NEW)-ARRAY['status','atualizado_em']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','atualizado_em']) THEN RAISE EXCEPTION 'Valor e identidade da parcela imutáveis' USING ERRCODE='23514'; END IF;
  SELECT pagamento_id INTO pid FROM pagamento_planos WHERE id=OLD.plano_id;
  IF EXISTS(SELECT 1 FROM pagamento_ajustes_contratuais WHERE pagamento_id=pid) AND NEW.status<>OLD.status THEN RAISE EXCEPTION 'Estado histórico preservado; consulte cronograma' USING ERRCODE='23514'; END IF;
 ELSE RAISE EXCEPTION 'Fato financeiro imutável' USING ERRCODE='23514';
 END IF; RETURN NEW;
END $$;

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['pagamento_eventos','pagamento_ajustes_contratuais','pagamento_cronograma_itens','pagamento_movimentos_contextos','pagamento_devolucao_alocacoes','pagamento_devolucao_comprovantes','pagamento_ajuste_bases'] LOOP
  EXECUTE format('CREATE TRIGGER p015_imutavel BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION kidmais_015_imutavel()',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['pagamento_gestoes','pagamento_tratamentos','pagamento_cronogramas','pagamento_credito_reservas','pagamento_devolucoes'] LOOP
  EXECUTE format('CREATE TRIGGER p015_processo BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION kidmais_015_processo()',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['pagamentos','pagamento_parcelas','pagamento_recebimentos','pagamento_estornos','pagamento_recebimento_alocacoes','pagamento_comprovantes'] LOOP
  EXECUTE format('CREATE TRIGGER p015_legado BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION kidmais_015_proteger_legado()',t);
 END LOOP;
END $$;

CREATE FUNCTION kidmais_015_validar() RETURNS trigger LANGUAGE plpgsql AS $$
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
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['pagamento_gestoes','pagamento_tratamentos','pagamento_eventos','pagamento_ajustes_contratuais','pagamento_cronogramas','pagamento_cronograma_itens','pagamento_movimentos_contextos','pagamento_credito_reservas','pagamento_devolucoes','pagamento_devolucao_alocacoes','pagamento_devolucao_comprovantes','pagamento_ajuste_bases'] LOOP
 EXECUTE format('CREATE CONSTRAINT TRIGGER p015_validar AFTER INSERT OR UPDATE ON %I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kidmais_015_validar()',t);
 END LOOP;
END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['pagamentos','pagamento_parcelas','pagamento_recebimentos','pagamento_estornos','pagamento_recebimento_alocacoes'] LOOP
 EXECUTE format('CREATE CONSTRAINT TRIGGER p015_validar_movimento AFTER INSERT OR UPDATE ON %I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kidmais_015_validar()',t);
 END LOOP;
END $$;
COMMIT;
