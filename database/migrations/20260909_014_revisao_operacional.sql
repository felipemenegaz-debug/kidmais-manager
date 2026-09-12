-- Migration 014 autorizada: proposta final corrigida. ZERO backfill.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL search_path=public,pg_catalog;
CREATE TABLE fechamento_revisoes (
 id uuid NOT NULL DEFAULT gen_random_uuid(),
 fechamento_id uuid NOT NULL,
 contrato_id uuid NOT NULL,
 contrato_versao_id uuid NOT NULL,
 versao_base_id uuid NOT NULL,
 estado varchar(20) NOT NULL DEFAULT 'EM_ELABORACAO',
 revisao integer NOT NULL DEFAULT 1,
 motivo text NOT NULL,
 origem varchar(30) NOT NULL DEFAULT 'ATENDIMENTO_KIDMAIS',
 chave_criacao uuid NOT NULL,
 fonte_base_hash char(64) NOT NULL,
 conteudo_hash char(64) NOT NULL,
 hold_destino_adquirido_em timestamptz,
 revisao_comercial_aprovada integer,
 aprovacao_negociacao_id uuid,
 aprovado_comercial_por_usuario_id uuid,
 aprovado_comercial_em timestamptz,
 congelado_snapshot_hash char(64),
 congelado_documento_id uuid,
 congelado_em timestamptz,
 congelado_por_usuario_id uuid,
 aplicado_em timestamptz,
 cancelado_em timestamptz,
 cancelado_por_usuario_id uuid,
 motivo_cancelamento text,
 criado_por_usuario_id uuid NOT NULL,
 atualizado_por_usuario_id uuid NOT NULL,
 criado_em timestamptz NOT NULL DEFAULT now(),
 atualizado_em timestamptz NOT NULL DEFAULT now(),
 cliente_id uuid NOT NULL,
 responsavel_adicional_id uuid,
 aniversariante_id uuid,
 idade_aniversariante_evento smallint,
 tema_festa text,
 data_evento date NOT NULL,
 horario_inicio time without time zone NOT NULL,
 horario_fim time without time zone NOT NULL,
 configuracao_agenda_id uuid NOT NULL,
 pacote_id uuid NOT NULL,
 tabela_preco_id uuid NOT NULL,
 preco_pacote_id uuid NOT NULL,
 regra_desconto_pacote_id uuid,
 categoria_horario varchar(20) NOT NULL,
 categoria_preco_aplicada varchar(20) NOT NULL,
 convidados smallint NOT NULL,
 convidados_faturados smallint NOT NULL,
 valor_pacote_base numeric(12,2) NOT NULL,
 desconto_percentual numeric(5,2) NOT NULL DEFAULT 0,
 valor_desconto_pacote numeric(12,2) NOT NULL DEFAULT 0,
 valor_pacote_aplicado numeric(12,2) NOT NULL,
 valor_adicionais numeric(12,2) NOT NULL DEFAULT 0,
 valor_tabela numeric(12,2) NOT NULL,
 valor_negociado numeric(12,2),
 valor_aprovado numeric(12,2),
 motivo_negociacao text,
 observacoes_negociacao text,
 forma_pagamento_pretendida varchar(30),
 condicao_pagamento jsonb,
 alteracoes_pacote text,
 observacoes_cliente text,
 observacoes_equipe text,
 usuario_responsavel_id uuid,
 buffet_status varchar(20) NOT NULL DEFAULT 'PENDENTE',
 buffet_salgados text,
 buffet_bebidas text,
 buffet_doces text,
 buffet_bolo text,
 buffet_outros text,
 PRIMARY KEY(id),
 CONSTRAINT fechamento_revisoes_versao_uk UNIQUE(contrato_versao_id),
 CONSTRAINT fechamento_revisoes_criacao_uk UNIQUE(chave_criacao),
 CONSTRAINT fechamento_revisoes_id_fechamento_uk UNIQUE(id,fechamento_id),
 CONSTRAINT fr_estado_ck CHECK(estado IN ('EM_ELABORACAO','CONGELADA','APLICADA','CANCELADA')),
 CONSTRAINT fr_revisao_ck CHECK(revisao>0),
 CONSTRAINT fr_origem_ck CHECK(origem='ATENDIMENTO_KIDMAIS'),
 CONSTRAINT fr_motivo_ck CHECK(btrim(motivo)<>''),
 CONSTRAINT fr_versoes_ck CHECK(versao_base_id<>contrato_versao_id),
 CONSTRAINT fr_hashes_ck CHECK(fonte_base_hash ~ '^[0-9a-f]{64}$' AND conteudo_hash ~ '^[0-9a-f]{64}$' AND (congelado_snapshot_hash IS NULL OR congelado_snapshot_hash ~ '^[0-9a-f]{64}$')),
 CONSTRAINT fr_horario_ck CHECK(horario_fim>horario_inicio),
 CONSTRAINT fr_convidados_ck CHECK(convidados>0 AND convidados_faturados>=convidados),
 CONSTRAINT fr_categorias_ck CHECK(categoria_horario IN ('PADRAO','NOBRE') AND categoria_preco_aplicada IN ('GERAL','PADRAO','NOBRE')),
 CONSTRAINT fr_valores_ck CHECK(valor_pacote_base>0 AND valor_pacote_aplicado>0 AND valor_tabela>0 AND valor_adicionais>=0 AND valor_desconto_pacote BETWEEN 0 AND valor_pacote_base AND desconto_percentual BETWEEN 0 AND 100 AND (valor_negociado IS NULL OR valor_negociado>0) AND (valor_aprovado IS NULL OR (valor_aprovado>0 AND valor_negociado IS NOT NULL))),
 CONSTRAINT fr_somas_ck CHECK(valor_pacote_aplicado=valor_pacote_base-valor_desconto_pacote AND valor_tabela=valor_pacote_aplicado+valor_adicionais),
 CONSTRAINT fr_idade_ck CHECK(idade_aniversariante_evento IS NULL OR idade_aniversariante_evento BETWEEN 0 AND 120),
 CONSTRAINT fr_buffet_ck CHECK(buffet_status IN ('PENDENTE','DEFINIDO')),
 CONSTRAINT fr_forma_ck CHECK(forma_pagamento_pretendida IS NULL OR forma_pagamento_pretendida IN ('PIX_AVISTA','PIX_PARCELADO','CARTAO_CIELO')),
 CONSTRAINT fr_condicao_ck CHECK(condicao_pagamento IS NULL OR COALESCE(jsonb_typeof(condicao_pagamento)='object' AND condicao_pagamento->'schemaVersao'='1'::jsonb AND condicao_pagamento->>'forma'=forma_pagamento_pretendida AND condicao_pagamento->>'revisaoStatus' IN ('PENDENTE','APROVADA','DISPENSADA','RECUSADA'),false)),
 CONSTRAINT fr_aprovacao_ck CHECK(num_nonnulls(revisao_comercial_aprovada,aprovacao_negociacao_id,aprovado_comercial_por_usuario_id,aprovado_comercial_em)=0 OR (num_nonnulls(revisao_comercial_aprovada,aprovacao_negociacao_id,aprovado_comercial_por_usuario_id,aprovado_comercial_em)=4 AND revisao_comercial_aprovada=revisao)),
 CONSTRAINT fr_congelamento_ck CHECK((num_nonnulls(congelado_snapshot_hash,congelado_documento_id,congelado_em,congelado_por_usuario_id)=0 AND estado IN ('EM_ELABORACAO','CANCELADA')) OR (num_nonnulls(congelado_snapshot_hash,congelado_documento_id,congelado_em,congelado_por_usuario_id)=4 AND estado IN ('CONGELADA','APLICADA','CANCELADA'))),
 CONSTRAINT fr_fim_ck CHECK((estado='APLICADA')=(aplicado_em IS NOT NULL) AND ((estado='CANCELADA' AND num_nonnulls(cancelado_em,cancelado_por_usuario_id,motivo_cancelamento)=3 AND btrim(motivo_cancelamento)<>'') OR (estado<>'CANCELADA' AND num_nonnulls(cancelado_em,cancelado_por_usuario_id,motivo_cancelamento)=0))),
 CONSTRAINT fr_datas_ck CHECK(atualizado_em>=criado_em AND (aprovado_comercial_em IS NULL OR aprovado_comercial_em>=criado_em) AND (congelado_em IS NULL OR congelado_em>=criado_em) AND (aplicado_em IS NULL OR aplicado_em>=congelado_em) AND (cancelado_em IS NULL OR cancelado_em>=criado_em) AND (congelado_em IS NULL OR aprovado_comercial_em<=congelado_em)),
 CONSTRAINT fr_hold_data_ck CHECK(hold_destino_adquirido_em IS NULL OR hold_destino_adquirido_em>=criado_em)
);
CREATE TABLE fechamento_revisao_adicionais (
 id uuid NOT NULL DEFAULT gen_random_uuid(),
 fechamento_revisao_id uuid NOT NULL,
 adicional_id uuid NOT NULL,
 preco_adicional_id uuid NOT NULL,
 nome_aplicado text NOT NULL,
 unidade_cobranca_aplicada varchar(20) NOT NULL,
 quantidade numeric(12,3) NOT NULL DEFAULT 1,
 valor_unitario_aplicado numeric(12,2) NOT NULL,
 valor_total numeric(12,2) NOT NULL,
 observacoes text,
 criado_em timestamptz NOT NULL DEFAULT now(),
 atualizado_em timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(id), CONSTRAINT fra_item_uk UNIQUE(fechamento_revisao_id,adicional_id),
 CONSTRAINT fra_nome_ck CHECK(btrim(nome_aplicado)<>''),
 CONSTRAINT fra_quantidade_ck CHECK(quantidade>0),
 CONSTRAINT fra_valores_ck CHECK(valor_unitario_aplicado>=0 AND valor_total>=0),
 CONSTRAINT fra_unidade_ck CHECK(unidade_cobranca_aplicada IN ('VALOR_FIXO','CONVIDADO','UNIDADE','CENTO','HORA','PACOTE','METRO')),
 CONSTRAINT fra_datas_ck CHECK(atualizado_em>=criado_em),
 FOREIGN KEY(fechamento_revisao_id) REFERENCES fechamento_revisoes(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
 FOREIGN KEY(adicional_id) REFERENCES adicionais(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
 FOREIGN KEY(preco_adicional_id) REFERENCES precos_adicional(id) ON UPDATE RESTRICT ON DELETE RESTRICT
);
ALTER TABLE contratos ADD CONSTRAINT contratos_fechamento_id_id_uk UNIQUE(fechamento_id,id);
ALTER TABLE aprovacoes_negociacao ADD COLUMN fechamento_revisao_id uuid, ADD COLUMN fechamento_revisao_numero integer, ADD COLUMN fechamento_revisao_hash char(64), ADD COLUMN chave_decisao uuid;
ALTER TABLE aprovacoes_negociacao ADD CONSTRAINT an_revisao_ck CHECK(num_nonnulls(fechamento_revisao_id,fechamento_revisao_numero,fechamento_revisao_hash,chave_decisao)=0 OR (num_nonnulls(fechamento_revisao_id,fechamento_revisao_numero,fechamento_revisao_hash,chave_decisao)=4 AND fechamento_revisao_numero>0 AND fechamento_revisao_hash ~ '^[0-9a-f]{64}$' AND aprovado_por_usuario_id IS NOT NULL)),
 ADD CONSTRAINT an_revisao_fk FOREIGN KEY(fechamento_revisao_id,fechamento_id) REFERENCES fechamento_revisoes(id,fechamento_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
 ADD CONSTRAINT an_id_revisao_uk UNIQUE(id,fechamento_revisao_id);
ALTER TABLE fechamento_revisoes ADD CONSTRAINT fr_contrato_fk FOREIGN KEY(fechamento_id,contrato_id) REFERENCES contratos(fechamento_id,id) ON UPDATE RESTRICT ON DELETE RESTRICT;
ALTER TABLE fechamento_revisoes ADD CONSTRAINT fr_versao_fk FOREIGN KEY(contrato_id,contrato_versao_id) REFERENCES contrato_versoes(contrato_id,id) ON UPDATE RESTRICT ON DELETE RESTRICT;
ALTER TABLE fechamento_revisoes ADD CONSTRAINT fr_base_fk FOREIGN KEY(contrato_id,versao_base_id) REFERENCES contrato_versoes(contrato_id,id) ON UPDATE RESTRICT ON DELETE RESTRICT;
ALTER TABLE fechamento_revisoes ADD CONSTRAINT fr_edicao_fk FOREIGN KEY(contrato_versao_id) REFERENCES contrato_edicoes(contrato_versao_id) ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE fechamento_revisoes ADD CONSTRAINT fr_documento_fk FOREIGN KEY(contrato_versao_id,congelado_documento_id) REFERENCES contrato_documentos(contrato_versao_id,id) ON UPDATE RESTRICT ON DELETE RESTRICT;
ALTER TABLE fechamento_revisoes ADD CONSTRAINT fr_aprovacao_fk FOREIGN KEY(aprovacao_negociacao_id,id) REFERENCES aprovacoes_negociacao(id,fechamento_revisao_id) ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE fechamento_revisoes ADD CONSTRAINT fr_cliente_id_fk FOREIGN KEY(cliente_id) REFERENCES clientes(id) ON UPDATE RESTRICT ON DELETE RESTRICT;
ALTER TABLE fechamento_revisoes ADD CONSTRAINT fr_aniversariante_id_fk FOREIGN KEY(aniversariante_id) REFERENCES aniversariantes(id) ON UPDATE RESTRICT ON DELETE RESTRICT;
ALTER TABLE fechamento_revisoes ADD CONSTRAINT fr_responsavel_adicional_id_fk FOREIGN KEY(responsavel_adicional_id) REFERENCES responsaveis_adicionais(id) ON UPDATE RESTRICT ON DELETE RESTRICT;
ALTER TABLE fechamento_revisoes ADD CONSTRAINT fr_configuracao_agenda_id_fk FOREIGN KEY(configuracao_agenda_id) REFERENCES configuracao_agenda(id) ON UPDATE RESTRICT ON DELETE RESTRICT;
ALTER TABLE fechamento_revisoes ADD CONSTRAINT fr_pacote_id_fk FOREIGN KEY(pacote_id) REFERENCES pacotes(id) ON UPDATE RESTRICT ON DELETE RESTRICT;
ALTER TABLE fechamento_revisoes ADD CONSTRAINT fr_tabela_preco_id_fk FOREIGN KEY(tabela_preco_id) REFERENCES tabelas_preco(id) ON UPDATE RESTRICT ON DELETE RESTRICT;
ALTER TABLE fechamento_revisoes ADD CONSTRAINT fr_preco_pacote_id_fk FOREIGN KEY(preco_pacote_id) REFERENCES precos_pacote(id) ON UPDATE RESTRICT ON DELETE RESTRICT;
ALTER TABLE fechamento_revisoes ADD CONSTRAINT fr_regra_desconto_pacote_id_fk FOREIGN KEY(regra_desconto_pacote_id) REFERENCES regras_desconto_pacote(id) ON UPDATE RESTRICT ON DELETE RESTRICT;
ALTER TABLE fechamento_revisoes ADD CONSTRAINT fr_usuario_responsavel_id_fk FOREIGN KEY(usuario_responsavel_id) REFERENCES usuarios_administrativos(id) ON UPDATE RESTRICT ON DELETE RESTRICT;
ALTER TABLE fechamento_revisoes ADD CONSTRAINT fr_aprovado_comercial_por_usuario_id_fk FOREIGN KEY(aprovado_comercial_por_usuario_id) REFERENCES usuarios_administrativos(id) ON UPDATE RESTRICT ON DELETE RESTRICT;
ALTER TABLE fechamento_revisoes ADD CONSTRAINT fr_congelado_por_usuario_id_fk FOREIGN KEY(congelado_por_usuario_id) REFERENCES usuarios_administrativos(id) ON UPDATE RESTRICT ON DELETE RESTRICT;
ALTER TABLE fechamento_revisoes ADD CONSTRAINT fr_cancelado_por_usuario_id_fk FOREIGN KEY(cancelado_por_usuario_id) REFERENCES usuarios_administrativos(id) ON UPDATE RESTRICT ON DELETE RESTRICT;
ALTER TABLE fechamento_revisoes ADD CONSTRAINT fr_criado_por_usuario_id_fk FOREIGN KEY(criado_por_usuario_id) REFERENCES usuarios_administrativos(id) ON UPDATE RESTRICT ON DELETE RESTRICT;
ALTER TABLE fechamento_revisoes ADD CONSTRAINT fr_atualizado_por_usuario_id_fk FOREIGN KEY(atualizado_por_usuario_id) REFERENCES usuarios_administrativos(id) ON UPDATE RESTRICT ON DELETE RESTRICT;
CREATE UNIQUE INDEX fechamento_revisoes_aberta_uk ON fechamento_revisoes(fechamento_id) WHERE estado IN ('EM_ELABORACAO','CONGELADA');
CREATE UNIQUE INDEX an_chave_decisao_uk ON aprovacoes_negociacao(chave_decisao) WHERE chave_decisao IS NOT NULL;
CREATE INDEX an_revisao_hist_idx ON aprovacoes_negociacao(fechamento_revisao_id,fechamento_revisao_numero,criado_em) WHERE fechamento_revisao_id IS NOT NULL;
CREATE INDEX fr_historico_idx ON fechamento_revisoes(fechamento_id,criado_em DESC);
CREATE INDEX fr_agenda_aberta_idx ON fechamento_revisoes(data_evento,horario_inicio,horario_fim) WHERE estado IN ('EM_ELABORACAO','CONGELADA') AND hold_destino_adquirido_em IS NOT NULL;
CREATE INDEX fr_base_idx ON fechamento_revisoes(versao_base_id);
CREATE INDEX fra_adicional_idx ON fechamento_revisao_adicionais(adicional_id);
CREATE INDEX fra_preco_idx ON fechamento_revisao_adicionais(preco_adicional_id);
CREATE INDEX fr_cliente_id_idx ON fechamento_revisoes(cliente_id);
CREATE INDEX fr_aniversariante_id_idx ON fechamento_revisoes(aniversariante_id);
CREATE INDEX fr_responsavel_adicional_id_idx ON fechamento_revisoes(responsavel_adicional_id);
CREATE INDEX fr_configuracao_agenda_id_idx ON fechamento_revisoes(configuracao_agenda_id);
CREATE INDEX fr_pacote_id_idx ON fechamento_revisoes(pacote_id);
CREATE INDEX fr_tabela_preco_id_idx ON fechamento_revisoes(tabela_preco_id);
CREATE INDEX fr_preco_pacote_id_idx ON fechamento_revisoes(preco_pacote_id);
CREATE INDEX fr_regra_desconto_pacote_id_idx ON fechamento_revisoes(regra_desconto_pacote_id);
CREATE INDEX fr_usuario_responsavel_id_idx ON fechamento_revisoes(usuario_responsavel_id);
CREATE INDEX fr_aprovado_comercial_por_usuario_id_idx ON fechamento_revisoes(aprovado_comercial_por_usuario_id);
CREATE INDEX fr_congelado_por_usuario_id_idx ON fechamento_revisoes(congelado_por_usuario_id);
CREATE INDEX fr_cancelado_por_usuario_id_idx ON fechamento_revisoes(cancelado_por_usuario_id);
CREATE INDEX fr_criado_por_usuario_id_idx ON fechamento_revisoes(criado_por_usuario_id);
CREATE INDEX fr_atualizado_por_usuario_id_idx ON fechamento_revisoes(atualizado_por_usuario_id);
CREATE INDEX fr_aprovacao_negociacao_id_idx ON fechamento_revisoes(aprovacao_negociacao_id);
CREATE INDEX fr_congelado_documento_id_idx ON fechamento_revisoes(congelado_documento_id);
CREATE FUNCTION kidmais_lock_datas_revisao(dias date[]) RETURNS void LANGUAGE plpgsql AS $$
DECLARE d date; BEGIN FOR d IN SELECT DISTINCT unnest(dias) ORDER BY 1 LOOP PERFORM pg_advisory_xact_lock(hashtextextended('kidmais:agenda:'||to_char(d,'YYYY-MM-DD'),0)); END LOOP; END $$;
CREATE FUNCTION kidmais_ocupacoes_operacionais(inicio date,fim date) RETURNS TABLE(fechamento_id uuid,revisao_id uuid,origem text,data date,horario_inicio time,horario_fim time) LANGUAGE sql STABLE AS $$
 SELECT f.id,NULL::uuid,'CONFIRMADA'::text,f.data_evento,f.horario_inicio,f.horario_fim FROM public.fechamentos f WHERE f.status='CONFIRMADO' AND f.data_evento BETWEEN inicio AND fim
 UNION ALL SELECT r.fechamento_id,r.id,'REVISAO_DESTINO'::text,r.data_evento,r.horario_inicio,r.horario_fim FROM public.fechamento_revisoes r JOIN public.fechamentos f ON f.id=r.fechamento_id JOIN public.contrato_fluxos cf ON cf.contrato_id=r.contrato_id
 WHERE f.status='CONFIRMADO' AND r.estado IN ('EM_ELABORACAO','CONGELADA') AND r.hold_destino_adquirido_em IS NOT NULL AND cf.versao_em_preparacao_id=r.contrato_versao_id AND cf.versao_vigente_id=r.versao_base_id AND r.data_evento BETWEEN inicio AND fim;
$$;
CREATE FUNCTION kidmais_hash_revisao_operacional(rid uuid) RETURNS text LANGUAGE sql STABLE AS $$
 SELECT encode(sha256(convert_to(jsonb_build_object('schemaVersao',1,'operacao',jsonb_build_object('cliente_id',r.cliente_id,'responsavel_adicional_id',r.responsavel_adicional_id,'aniversariante_id',r.aniversariante_id,'idade_aniversariante_evento',r.idade_aniversariante_evento,'tema_festa',r.tema_festa,'data_evento',r.data_evento,'horario_inicio',r.horario_inicio,'horario_fim',r.horario_fim,'configuracao_agenda_id',r.configuracao_agenda_id,'pacote_id',r.pacote_id,'tabela_preco_id',r.tabela_preco_id,'preco_pacote_id',r.preco_pacote_id,'regra_desconto_pacote_id',r.regra_desconto_pacote_id,'categoria_horario',r.categoria_horario,'categoria_preco_aplicada',r.categoria_preco_aplicada,'convidados',r.convidados,'convidados_faturados',r.convidados_faturados,'valor_pacote_base',r.valor_pacote_base,'desconto_percentual',r.desconto_percentual,'valor_desconto_pacote',r.valor_desconto_pacote,'valor_pacote_aplicado',r.valor_pacote_aplicado,'valor_adicionais',r.valor_adicionais,'valor_tabela',r.valor_tabela,'valor_negociado',r.valor_negociado,'valor_aprovado',r.valor_aprovado,'motivo_negociacao',r.motivo_negociacao,'observacoes_negociacao',r.observacoes_negociacao,'forma_pagamento_pretendida',r.forma_pagamento_pretendida,'condicao_pagamento',r.condicao_pagamento,'alteracoes_pacote',r.alteracoes_pacote,'observacoes_cliente',r.observacoes_cliente,'observacoes_equipe',r.observacoes_equipe,'usuario_responsavel_id',r.usuario_responsavel_id,'buffet_status',r.buffet_status,'buffet_salgados',r.buffet_salgados,'buffet_bebidas',r.buffet_bebidas,'buffet_doces',r.buffet_doces,'buffet_bolo',r.buffet_bolo,'buffet_outros',r.buffet_outros),'adicionais',COALESCE((SELECT jsonb_agg(to_jsonb(a)-ARRAY['id','fechamento_id','fechamento_revisao_id','criado_em','atualizado_em'] ORDER BY a.adicional_id) FROM public.fechamento_revisao_adicionais a WHERE a.fechamento_revisao_id=r.id),'[]'::jsonb))::text,'UTF8')),'hex') FROM public.fechamento_revisoes r WHERE r.id=rid;
$$;
CREATE FUNCTION kidmais_preservar_revisao_operacional() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR OLD.estado IN ('APLICADA','CANCELADA') THEN RAISE EXCEPTION 'Histórico operacional imutável' USING ERRCODE='23514'; END IF;
 IF ROW(NEW.id,NEW.fechamento_id,NEW.contrato_id,NEW.contrato_versao_id,NEW.versao_base_id,NEW.chave_criacao,NEW.fonte_base_hash,NEW.criado_em,NEW.criado_por_usuario_id,NEW.origem) IS DISTINCT FROM ROW(OLD.id,OLD.fechamento_id,OLD.contrato_id,OLD.contrato_versao_id,OLD.versao_base_id,OLD.chave_criacao,OLD.fonte_base_hash,OLD.criado_em,OLD.criado_por_usuario_id,OLD.origem) THEN RAISE EXCEPTION 'Identidade/base da revisão imutável' USING ERRCODE='23514'; END IF;
 IF NOT (NEW.estado=OLD.estado OR (OLD.estado='EM_ELABORACAO' AND NEW.estado IN ('CONGELADA','CANCELADA')) OR (OLD.estado='CONGELADA' AND NEW.estado IN ('APLICADA','CANCELADA'))) THEN RAISE EXCEPTION 'Transição operacional inválida' USING ERRCODE='23514'; END IF;
 IF OLD.estado='CONGELADA' AND (to_jsonb(NEW)-ARRAY['estado','aplicado_em','cancelado_em','cancelado_por_usuario_id','motivo_cancelamento','atualizado_em','atualizado_por_usuario_id','hold_destino_adquirido_em']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['estado','aplicado_em','cancelado_em','cancelado_por_usuario_id','motivo_cancelamento','atualizado_em','atualizado_por_usuario_id','hold_destino_adquirido_em']) THEN RAISE EXCEPTION 'Preparação congelada' USING ERRCODE='23514'; END IF;
 IF OLD.estado='CONGELADA' AND OLD.hold_destino_adquirido_em IS NOT NULL AND NEW.hold_destino_adquirido_em IS DISTINCT FROM OLD.hold_destino_adquirido_em THEN RAISE EXCEPTION 'Hold congelado não pode ser alterado' USING ERRCODE='23514'; END IF;
 IF NEW.conteudo_hash IS DISTINCT FROM OLD.conteudo_hash AND (OLD.estado<>'EM_ELABORACAO' OR NEW.revisao<>OLD.revisao+1) THEN RAISE EXCEPTION 'Conteúdo exige nova revisão otimista' USING ERRCODE='23514'; END IF;
 IF NEW.conteudo_hash=OLD.conteudo_hash AND NEW.revisao<>OLD.revisao THEN RAISE EXCEPTION 'Revisão sem mudança de conteúdo' USING ERRCODE='23514'; END IF;
 IF OLD.hold_destino_adquirido_em IS NOT NULL AND NEW.hold_destino_adquirido_em IS NULL THEN RAISE EXCEPTION 'Hold só libera por cancelamento/aplicação' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION kidmais_preservar_adicional_revisao() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE rid uuid; estado_pai text;
BEGIN
 rid:=CASE WHEN TG_OP='DELETE' THEN OLD.fechamento_revisao_id ELSE NEW.fechamento_revisao_id END;
 SELECT estado INTO estado_pai FROM public.fechamento_revisoes WHERE id=rid FOR UPDATE;
 IF estado_pai IS DISTINCT FROM 'EM_ELABORACAO' THEN RAISE EXCEPTION 'Adicionais da preparação congelados' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' AND (NEW.id<>OLD.id OR NEW.fechamento_revisao_id<>OLD.fechamento_revisao_id OR NEW.criado_em<>OLD.criado_em) THEN RAISE EXCEPTION 'Identidade do adicional imutável' USING ERRCODE='23514'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
CREATE FUNCTION kidmais_preservar_aprovacao_revisao() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.fechamento_revisao_id IS NOT NULL THEN RAISE EXCEPTION 'Decisão da revisão é histórica e imutável' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' AND NEW.fechamento_revisao_id IS NOT NULL THEN RAISE EXCEPTION 'Decisão de revisão exige nova linha' USING ERRCODE='23514'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
CREATE FUNCTION kidmais_validar_revisao_operacional() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE rid uuid; cid uuid; r public.fechamento_revisoes%ROWTYPE; e public.contrato_edicoes%ROWTYPE; f public.fechamentos%ROWTYPE; v public.contrato_versoes%ROWTYPE; flow public.contrato_fluxos%ROWTYPE; approval public.aprovacoes_negociacao%ROWTYPE; current_hash text;
BEGIN
 IF TG_TABLE_NAME='fechamento_revisoes' THEN rid:=NEW.id;
 ELSIF TG_TABLE_NAME='fechamento_revisao_adicionais' THEN rid:=CASE WHEN TG_OP='DELETE' THEN OLD.fechamento_revisao_id ELSE NEW.fechamento_revisao_id END;
 ELSIF TG_TABLE_NAME='aprovacoes_negociacao' THEN rid:=NEW.fechamento_revisao_id;
 ELSIF TG_TABLE_NAME='contrato_fluxos' THEN cid:=NEW.contrato_id;
 ELSIF TG_TABLE_NAME='contrato_versoes' THEN SELECT id INTO rid FROM public.fechamento_revisoes WHERE contrato_versao_id=NEW.id;
 ELSE SELECT id INTO rid FROM public.fechamento_revisoes WHERE contrato_versao_id=NEW.contrato_versao_id; END IF;
 IF rid IS NULL AND cid IS NOT NULL THEN SELECT id INTO rid FROM public.fechamento_revisoes WHERE contrato_id=cid AND estado IN ('EM_ELABORACAO','CONGELADA') LIMIT 1; END IF;
 IF rid IS NULL THEN RETURN NULL; END IF;
 SELECT * INTO r FROM public.fechamento_revisoes WHERE id=rid; IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT * INTO f FROM public.fechamentos WHERE id=r.fechamento_id;
 SELECT * INTO e FROM public.contrato_edicoes WHERE contrato_versao_id=r.contrato_versao_id;
 SELECT * INTO v FROM public.contrato_versoes WHERE id=r.contrato_versao_id;
 SELECT * INTO flow FROM public.contrato_fluxos WHERE contrato_id=r.contrato_id;
 IF e.origem_versao_id IS DISTINCT FROM r.versao_base_id OR NOT EXISTS(SELECT 1 FROM public.contrato_versoes b WHERE b.id=r.versao_base_id AND b.contrato_id=r.contrato_id AND b.status='ASSINADA' AND b.numero_versao<v.numero_versao) THEN RAISE EXCEPTION 'Base/V2 da preparação incompatível' USING ERRCODE='23514'; END IF;
 IF r.conteudo_hash IS DISTINCT FROM public.kidmais_hash_revisao_operacional(r.id) OR r.valor_adicionais IS DISTINCT FROM (SELECT COALESCE(sum(valor_total),0) FROM public.fechamento_revisao_adicionais WHERE fechamento_revisao_id=r.id) THEN RAISE EXCEPTION 'Hash/soma da preparação inválidos' USING ERRCODE='23514'; END IF;
 IF r.estado IN ('EM_ELABORACAO','CONGELADA') THEN
  IF flow.versao_vigente_id IS DISTINCT FROM r.versao_base_id OR flow.versao_em_preparacao_id IS DISTINCT FROM r.contrato_versao_id THEN RAISE EXCEPTION 'Preparação perdeu vínculo com vigência' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.clientes WHERE id=r.cliente_id AND status<>'MESCLADO' AND cliente_principal_id IS NULL) OR (r.aniversariante_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.aniversariantes WHERE id=r.aniversariante_id AND cliente_id=r.cliente_id AND ativo)) OR (r.responsavel_adicional_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.responsaveis_adicionais WHERE id=r.responsavel_adicional_id AND cliente_id=r.cliente_id AND ativo)) THEN RAISE EXCEPTION 'Vínculos cadastrais inválidos' USING ERRCODE='23514'; END IF;
 END IF;
 IF (r.estado='EM_ELABORACAO' AND e.estado<>'EM_ELABORACAO') OR (r.estado='CONGELADA' AND e.estado NOT IN ('ASSINADA_KIDMAIS','AGUARDANDO_CLIENTE')) OR (r.estado='APLICADA' AND (e.estado<>'CONCLUIDA' OR v.status<>'ASSINADA')) OR (r.estado='CANCELADA' AND (e.estado<>'CANCELADA' OR v.status<>'CANCELADA')) THEN RAISE EXCEPTION 'Estado operacional/documental incoerente' USING ERRCODE='23514'; END IF;
 IF r.aprovacao_negociacao_id IS NOT NULL THEN
  SELECT * INTO approval FROM public.aprovacoes_negociacao WHERE id=r.aprovacao_negociacao_id;
  IF approval.fechamento_revisao_id IS DISTINCT FROM r.id OR approval.fechamento_revisao_numero IS DISTINCT FROM r.revisao OR approval.fechamento_revisao_hash IS DISTINCT FROM r.conteudo_hash OR approval.status NOT IN ('APROVADO','CORRIGIDO') OR approval.aprovado_por_usuario_id IS DISTINCT FROM r.aprovado_comercial_por_usuario_id THEN RAISE EXCEPTION 'Aprovação não corresponde à preparação' USING ERRCODE='23514'; END IF;
 END IF;
 IF r.estado IN ('CONGELADA','APLICADA') OR r.congelado_em IS NOT NULL THEN
  IF r.revisao_comercial_aprovada IS DISTINCT FROM r.revisao OR r.congelado_snapshot_hash IS DISTINCT FROM v.snapshot_hash OR NOT EXISTS(SELECT 1 FROM public.contrato_assinaturas a WHERE a.contrato_versao_id=v.id AND a.parte='KIDMAIS' AND a.documento_id=r.congelado_documento_id AND a.snapshot_hash=r.congelado_snapshot_hash AND a.usuario_id=r.congelado_por_usuario_id) THEN RAISE EXCEPTION 'Preparação exige aprovação e prova exatas' USING ERRCODE='23514'; END IF;
  IF v.snapshot->'revisaoOperacional' IS DISTINCT FROM jsonb_build_object('id',r.id,'revisao',r.revisao,'conteudoHash',r.conteudo_hash,'versaoBaseId',r.versao_base_id) THEN RAISE EXCEPTION 'Snapshot não documenta preparação exata' USING ERRCODE='23514'; END IF;
 END IF;
 IF TG_TABLE_NAME='aprovacoes_negociacao' THEN
 IF NEW.fechamento_revisao_id IS NOT NULL THEN
  IF NEW.fechamento_revisao_numero<>r.revisao OR NEW.fechamento_revisao_hash<>r.conteudo_hash OR NOT EXISTS(SELECT 1 FROM public.usuarios_administrativos WHERE id=NEW.aprovado_por_usuario_id AND ativo) THEN RAISE EXCEPTION 'Decisão exige revisão/autor válidos' USING ERRCODE='23514'; END IF;
 END IF; END IF;
 IF TG_TABLE_NAME='fechamento_revisoes' AND TG_OP='UPDATE' THEN
  IF OLD.estado<>'APLICADA' AND r.estado='APLICADA' THEN
   IF flow.versao_vigente_id IS DISTINCT FROM r.contrato_versao_id OR flow.versao_em_preparacao_id IS NOT NULL OR NOT EXISTS(SELECT 1 FROM public.contrato_assinaturas WHERE contrato_versao_id=r.contrato_versao_id AND parte='CLIENTE') THEN RAISE EXCEPTION 'Aplicação exige promoção e aceite atômicos' USING ERRCODE='23514'; END IF;
   IF jsonb_build_object('cliente_id',f.cliente_id,'responsavel_adicional_id',f.responsavel_adicional_id,'aniversariante_id',f.aniversariante_id,'idade_aniversariante_evento',f.idade_aniversariante_evento,'tema_festa',f.tema_festa,'data_evento',f.data_evento,'horario_inicio',f.horario_inicio,'horario_fim',f.horario_fim,'configuracao_agenda_id',f.configuracao_agenda_id,'pacote_id',f.pacote_id,'tabela_preco_id',f.tabela_preco_id,'preco_pacote_id',f.preco_pacote_id,'regra_desconto_pacote_id',f.regra_desconto_pacote_id,'categoria_horario',f.categoria_horario,'categoria_preco_aplicada',f.categoria_preco_aplicada,'convidados',f.convidados,'convidados_faturados',f.convidados_faturados,'valor_pacote_base',f.valor_pacote_base,'desconto_percentual',f.desconto_percentual,'valor_desconto_pacote',f.valor_desconto_pacote,'valor_pacote_aplicado',f.valor_pacote_aplicado,'valor_adicionais',f.valor_adicionais,'valor_tabela',f.valor_tabela,'valor_negociado',f.valor_negociado,'valor_aprovado',f.valor_aprovado,'motivo_negociacao',f.motivo_negociacao,'observacoes_negociacao',f.observacoes_negociacao,'forma_pagamento_pretendida',f.forma_pagamento_pretendida,'condicao_pagamento',f.condicao_pagamento,'alteracoes_pacote',f.alteracoes_pacote,'observacoes_cliente',f.observacoes_cliente,'observacoes_equipe',f.observacoes_equipe,'usuario_responsavel_id',f.usuario_responsavel_id,'buffet_status',f.buffet_status,'buffet_salgados',f.buffet_salgados,'buffet_bebidas',f.buffet_bebidas,'buffet_doces',f.buffet_doces,'buffet_bolo',f.buffet_bolo,'buffet_outros',f.buffet_outros) IS DISTINCT FROM jsonb_build_object('cliente_id',r.cliente_id,'responsavel_adicional_id',r.responsavel_adicional_id,'aniversariante_id',r.aniversariante_id,'idade_aniversariante_evento',r.idade_aniversariante_evento,'tema_festa',r.tema_festa,'data_evento',r.data_evento,'horario_inicio',r.horario_inicio,'horario_fim',r.horario_fim,'configuracao_agenda_id',r.configuracao_agenda_id,'pacote_id',r.pacote_id,'tabela_preco_id',r.tabela_preco_id,'preco_pacote_id',r.preco_pacote_id,'regra_desconto_pacote_id',r.regra_desconto_pacote_id,'categoria_horario',r.categoria_horario,'categoria_preco_aplicada',r.categoria_preco_aplicada,'convidados',r.convidados,'convidados_faturados',r.convidados_faturados,'valor_pacote_base',r.valor_pacote_base,'desconto_percentual',r.desconto_percentual,'valor_desconto_pacote',r.valor_desconto_pacote,'valor_pacote_aplicado',r.valor_pacote_aplicado,'valor_adicionais',r.valor_adicionais,'valor_tabela',r.valor_tabela,'valor_negociado',r.valor_negociado,'valor_aprovado',r.valor_aprovado,'motivo_negociacao',r.motivo_negociacao,'observacoes_negociacao',r.observacoes_negociacao,'forma_pagamento_pretendida',r.forma_pagamento_pretendida,'condicao_pagamento',r.condicao_pagamento,'alteracoes_pacote',r.alteracoes_pacote,'observacoes_cliente',r.observacoes_cliente,'observacoes_equipe',r.observacoes_equipe,'usuario_responsavel_id',r.usuario_responsavel_id,'buffet_status',r.buffet_status,'buffet_salgados',r.buffet_salgados,'buffet_bebidas',r.buffet_bebidas,'buffet_doces',r.buffet_doces,'buffet_bolo',r.buffet_bolo,'buffet_outros',r.buffet_outros) OR (SELECT COALESCE(jsonb_agg(to_jsonb(a)-ARRAY['id','fechamento_id','fechamento_revisao_id','criado_em','atualizado_em'] ORDER BY a.adicional_id),'[]'::jsonb) FROM public.fechamento_adicionais a WHERE a.fechamento_id=f.id) IS DISTINCT FROM (SELECT COALESCE(jsonb_agg(to_jsonb(a)-ARRAY['id','fechamento_id','fechamento_revisao_id','criado_em','atualizado_em'] ORDER BY a.adicional_id),'[]'::jsonb) FROM public.fechamento_revisao_adicionais a WHERE a.fechamento_revisao_id=r.id) THEN RAISE EXCEPTION 'Operação não aplicada integralmente' USING ERRCODE='23514'; END IF;
  END IF;
 END IF;
 RETURN NULL;
END $$;
CREATE FUNCTION kidmais_proteger_fechamento_em_revisao() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE fid uuid; r public.fechamento_revisoes%ROWTYPE; f public.fechamentos%ROWTYPE; h text;
BEGIN
 IF TG_TABLE_NAME='fechamentos' THEN fid:=NEW.id;
 ELSIF TG_TABLE_NAME='fechamento_revisoes' THEN fid:=NEW.fechamento_id;
 ELSE fid:=CASE WHEN TG_OP='DELETE' THEN OLD.fechamento_id ELSE NEW.fechamento_id END; END IF;
 IF TG_TABLE_NAME='fechamento_revisoes' THEN
  SELECT * INTO r FROM public.fechamento_revisoes WHERE id=NEW.id AND estado IN ('EM_ELABORACAO','CONGELADA','CANCELADA');
 ELSE SELECT * INTO r FROM public.fechamento_revisoes WHERE fechamento_id=fid AND estado IN ('EM_ELABORACAO','CONGELADA'); END IF;
 IF r.id IS NULL THEN RETURN NULL; END IF;
 SELECT * INTO f FROM public.fechamentos WHERE id=fid;
 SELECT encode(sha256(convert_to(jsonb_build_object('schemaVersao',1,'operacao',jsonb_build_object('cliente_id',f.cliente_id,'responsavel_adicional_id',f.responsavel_adicional_id,'aniversariante_id',f.aniversariante_id,'idade_aniversariante_evento',f.idade_aniversariante_evento,'tema_festa',f.tema_festa,'data_evento',f.data_evento,'horario_inicio',f.horario_inicio,'horario_fim',f.horario_fim,'configuracao_agenda_id',f.configuracao_agenda_id,'pacote_id',f.pacote_id,'tabela_preco_id',f.tabela_preco_id,'preco_pacote_id',f.preco_pacote_id,'regra_desconto_pacote_id',f.regra_desconto_pacote_id,'categoria_horario',f.categoria_horario,'categoria_preco_aplicada',f.categoria_preco_aplicada,'convidados',f.convidados,'convidados_faturados',f.convidados_faturados,'valor_pacote_base',f.valor_pacote_base,'desconto_percentual',f.desconto_percentual,'valor_desconto_pacote',f.valor_desconto_pacote,'valor_pacote_aplicado',f.valor_pacote_aplicado,'valor_adicionais',f.valor_adicionais,'valor_tabela',f.valor_tabela,'valor_negociado',f.valor_negociado,'valor_aprovado',f.valor_aprovado,'motivo_negociacao',f.motivo_negociacao,'observacoes_negociacao',f.observacoes_negociacao,'forma_pagamento_pretendida',f.forma_pagamento_pretendida,'condicao_pagamento',f.condicao_pagamento,'alteracoes_pacote',f.alteracoes_pacote,'observacoes_cliente',f.observacoes_cliente,'observacoes_equipe',f.observacoes_equipe,'usuario_responsavel_id',f.usuario_responsavel_id,'buffet_status',f.buffet_status,'buffet_salgados',f.buffet_salgados,'buffet_bebidas',f.buffet_bebidas,'buffet_doces',f.buffet_doces,'buffet_bolo',f.buffet_bolo,'buffet_outros',f.buffet_outros),'adicionais',COALESCE((SELECT jsonb_agg(to_jsonb(a)-ARRAY['id','fechamento_id','fechamento_revisao_id','criado_em','atualizado_em'] ORDER BY a.adicional_id) FROM public.fechamento_adicionais a WHERE a.fechamento_id=f.id),'[]'::jsonb),'versaoBaseId',r.versao_base_id,'snapshotBaseHash',(SELECT snapshot_hash FROM public.contrato_versoes WHERE id=r.versao_base_id))::text,'UTF8')),'hex') INTO h;
 IF h IS DISTINCT FROM r.fonte_base_hash THEN RAISE EXCEPTION 'Fechamento vigente mudou durante preparação' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE FUNCTION kidmais_validar_agenda_revisao() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r public.fechamento_revisoes%ROWTYPE; f public.fechamentos%ROWTYPE; target_day date; ini time; fim time; fid uuid;
BEGIN
 IF TG_TABLE_NAME='fechamentos' THEN
  SELECT * INTO f FROM public.fechamentos WHERE id=NEW.id;
  IF f.status<>'CONFIRMADO' THEN RETURN NULL; END IF;
  IF TG_OP='UPDATE' THEN IF OLD.status='CONFIRMADO' AND ROW(OLD.data_evento,OLD.horario_inicio,OLD.horario_fim)=ROW(f.data_evento,f.horario_inicio,f.horario_fim) THEN RETURN NULL; END IF; END IF;
  target_day:=f.data_evento; ini:=f.horario_inicio; fim:=f.horario_fim; fid:=f.id;
 ELSE
  SELECT * INTO r FROM public.fechamento_revisoes WHERE id=NEW.id;
  SELECT * INTO f FROM public.fechamentos WHERE id=r.fechamento_id;
  IF r.estado='CANCELADA' THEN RETURN NULL; END IF;
  IF r.hold_destino_adquirido_em IS NOT NULL AND f.status<>'CONFIRMADO' THEN RAISE EXCEPTION 'Hold exige reserva vigente confirmada' USING ERRCODE='23514'; END IF;
  -- A deferred event may observe the already-applied terminal row.
  IF r.hold_destino_adquirido_em IS NULL AND r.estado<>'APLICADA' THEN RETURN NULL; END IF;
  IF r.estado='APLICADA' AND f.status='CONFIRMADO' AND r.hold_destino_adquirido_em IS NULL THEN RAISE EXCEPTION 'Remarcação confirmada exige hold validado' USING ERRCODE='23514'; END IF;
  target_day:=r.data_evento; ini:=r.horario_inicio; fim:=r.horario_fim; fid:=r.fechamento_id;
 END IF;
 PERFORM public.kidmais_lock_datas_revisao(ARRAY[target_day]);
 IF EXISTS(SELECT 1 FROM public.kidmais_ocupacoes_operacionais(target_day,target_day) o WHERE o.fechamento_id<>fid AND o.horario_inicio<fim AND o.horario_fim>ini) OR EXISTS(SELECT 1 FROM public.bloqueios_agenda b WHERE b.ativo AND b.data=target_day AND (b.dia_inteiro OR b.horario_inicio IS NULL OR b.horario_fim IS NULL OR (b.horario_inicio<fim AND b.horario_fim>ini))) THEN RAISE EXCEPTION 'Conflito de agenda da revisão' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE FUNCTION kidmais_proteger_bloqueio_revisao() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' THEN PERFORM public.kidmais_lock_datas_revisao(ARRAY[OLD.data,NEW.data]); ELSE PERFORM public.kidmais_lock_datas_revisao(ARRAY[NEW.data]); END IF;
 IF NOT NEW.ativo THEN RETURN NEW; END IF;
 IF EXISTS(SELECT 1 FROM public.kidmais_ocupacoes_operacionais(NEW.data,NEW.data) o WHERE EXISTS(SELECT 1 FROM public.fechamento_revisoes r WHERE r.fechamento_id=o.fechamento_id AND r.estado IN ('EM_ELABORACAO','CONGELADA')) AND (NEW.dia_inteiro OR NEW.horario_inicio IS NULL OR NEW.horario_fim IS NULL OR (o.horario_inicio<NEW.horario_fim AND o.horario_fim>NEW.horario_inicio))) THEN RAISE EXCEPTION 'Bloqueio conflita com reserva em revisão' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER fr_preservar_trg BEFORE UPDATE OR DELETE ON fechamento_revisoes FOR EACH ROW EXECUTE FUNCTION kidmais_preservar_revisao_operacional();
CREATE TRIGGER fr_atualizado_trg BEFORE UPDATE ON fechamento_revisoes FOR EACH ROW EXECUTE FUNCTION kidmais_set_atualizado_em();
CREATE TRIGGER fra_preservar_trg BEFORE INSERT OR UPDATE OR DELETE ON fechamento_revisao_adicionais FOR EACH ROW EXECUTE FUNCTION kidmais_preservar_adicional_revisao();
CREATE TRIGGER fra_atualizado_trg BEFORE UPDATE ON fechamento_revisao_adicionais FOR EACH ROW EXECUTE FUNCTION kidmais_set_atualizado_em();
CREATE CONSTRAINT TRIGGER fr_validar_trg AFTER INSERT OR UPDATE ON fechamento_revisoes DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kidmais_validar_revisao_operacional();
CREATE CONSTRAINT TRIGGER fra_validar_trg AFTER INSERT OR UPDATE OR DELETE ON fechamento_revisao_adicionais DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kidmais_validar_revisao_operacional();
CREATE CONSTRAINT TRIGGER fr_edicao_validar_trg AFTER INSERT OR UPDATE ON contrato_edicoes DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kidmais_validar_revisao_operacional();
CREATE CONSTRAINT TRIGGER fr_fluxo_validar_trg AFTER INSERT OR UPDATE ON contrato_fluxos DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kidmais_validar_revisao_operacional();
CREATE CONSTRAINT TRIGGER fr_versao_validar_trg AFTER INSERT OR UPDATE ON contrato_versoes DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kidmais_validar_revisao_operacional();
CREATE CONSTRAINT TRIGGER fr_assinatura_validar_trg AFTER INSERT ON contrato_assinaturas DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kidmais_validar_revisao_operacional();
CREATE CONSTRAINT TRIGGER fr_aprovacao_validar_trg AFTER INSERT ON aprovacoes_negociacao DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kidmais_validar_revisao_operacional();
CREATE CONSTRAINT TRIGGER fr_fechamento_proteger_trg AFTER UPDATE ON fechamentos DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kidmais_proteger_fechamento_em_revisao();
CREATE CONSTRAINT TRIGGER fr_adicionais_proteger_trg AFTER INSERT OR UPDATE OR DELETE ON fechamento_adicionais DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kidmais_proteger_fechamento_em_revisao();
CREATE CONSTRAINT TRIGGER fr_base_proteger_trg AFTER INSERT OR UPDATE ON fechamento_revisoes DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kidmais_proteger_fechamento_em_revisao();
CREATE CONSTRAINT TRIGGER fr_agenda_validar_trg AFTER INSERT OR UPDATE ON fechamento_revisoes DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kidmais_validar_agenda_revisao();
CREATE CONSTRAINT TRIGGER fr_confirmacao_agenda_trg AFTER INSERT OR UPDATE ON fechamentos DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kidmais_validar_agenda_revisao();
CREATE TRIGGER fr_bloqueio_proteger_trg BEFORE INSERT OR UPDATE ON bloqueios_agenda FOR EACH ROW EXECUTE FUNCTION kidmais_proteger_bloqueio_revisao();
CREATE TRIGGER fr_aprovacao_preservar_trg BEFORE UPDATE OR DELETE ON aprovacoes_negociacao FOR EACH ROW EXECUTE FUNCTION kidmais_preservar_aprovacao_revisao();
COMMIT;
