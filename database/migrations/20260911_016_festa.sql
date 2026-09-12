BEGIN;
-- Escolhas textuais e preparação. Sem seed ou backfill.
CREATE TABLE festa_areas (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), nome text NOT NULL CHECK(length(trim(nome)) BETWEEN 1 AND 100),
 ativo boolean NOT NULL DEFAULT true, revisao integer NOT NULL DEFAULT 1 CHECK(revisao>0),
 criado_por uuid NOT NULL REFERENCES usuarios_administrativos(id), criado_em timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX festa_areas_nome_uk ON festa_areas(lower(trim(nome)));
CREATE TABLE festa_usuario_capacidades (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), usuario_id uuid NOT NULL REFERENCES usuarios_administrativos(id),
 capacidade text NOT NULL CHECK(capacidade IN ('FESTA_CONSULTAR','FESTA_CRIAR','FESTA_OPERAR','FESTA_CORRIGIR','FESTA_CONFIGURAR_AREAS')),
 concedido_por uuid NOT NULL REFERENCES usuarios_administrativos(id), concedido_em timestamptz NOT NULL DEFAULT now(), motivo text NOT NULL CHECK(length(trim(motivo))>=3),
 revogado_por uuid REFERENCES usuarios_administrativos(id), revogado_em timestamptz, motivo_revogacao text,
 CHECK((revogado_por IS NULL AND revogado_em IS NULL AND motivo_revogacao IS NULL) OR (revogado_por IS NOT NULL AND revogado_em IS NOT NULL AND length(trim(motivo_revogacao))>=3))
);
CREATE UNIQUE INDEX festa_capacidade_ativa_uk ON festa_usuario_capacidades(usuario_id,capacidade) WHERE revogado_em IS NULL;
CREATE TABLE festas (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contrato_id uuid NOT NULL REFERENCES contratos(id),
 versao_contratual_criacao_id uuid NOT NULL,
 invalidada_em timestamptz, invalidada_por uuid REFERENCES usuarios_administrativos(id), motivo_invalidacao text,
 CHECK((invalidada_em IS NULL AND invalidada_por IS NULL AND motivo_invalidacao IS NULL) OR (invalidada_em IS NOT NULL AND invalidada_por IS NOT NULL AND motivo_invalidacao IS NOT NULL AND length(trim(motivo_invalidacao))>=3)),
 revisao integer NOT NULL DEFAULT 1 CHECK(revisao>0),
 chave_criacao uuid NOT NULL UNIQUE, payload_hash text NOT NULL CHECK(payload_hash ~ '^[0-9a-f]{64}$$'),
 criado_por uuid NOT NULL REFERENCES usuarios_administrativos(id), criado_em timestamptz NOT NULL DEFAULT now(), atualizado_em timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,contrato_id),
 FOREIGN KEY(contrato_id,versao_contratual_criacao_id) REFERENCES contrato_versoes(contrato_id,id)
);
CREATE UNIQUE INDEX festas_contrato_ativo_uk ON festas(contrato_id) WHERE invalidada_em IS NULL;
CREATE TABLE festa_buffet (
 festa_id uuid PRIMARY KEY REFERENCES festas(id),
 salgados text, doces text, bolo text, bebidas text, lembrancinha text, empratado text, bombom text,
 versao_contratual_id uuid NOT NULL REFERENCES contrato_versoes(id),
 atualizado_por uuid NOT NULL REFERENCES usuarios_administrativos(id), atualizado_em timestamptz NOT NULL DEFAULT now(),
 CHECK(length(salgados)<=2000 AND length(doces)<=2000 AND length(bolo)<=2000 AND length(bebidas)<=2000 AND length(lembrancinha)<=2000 AND length(empratado)<=2000 AND length(bombom)<=2000)
);
CREATE TABLE festa_tarefas (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), festa_id uuid NOT NULL REFERENCES festas(id),
 titulo text NOT NULL CHECK(length(trim(titulo)) BETWEEN 1 AND 300), descricao text NOT NULL DEFAULT '',
 categoria text NOT NULL DEFAULT 'ANTES' CHECK(categoria IN ('ANTES','DEPOIS')),
 estado text NOT NULL DEFAULT 'PENDENTE' CHECK(estado IN ('PENDENTE','CONCLUIDA','NAO_SE_APLICA')),
 prioridade text NOT NULL CHECK(prioridade IN ('NORMAL','ATENCAO','CRITICA')),
 area_id uuid REFERENCES festa_areas(id), responsavel_id uuid REFERENCES usuarios_administrativos(id), prazo timestamptz,
 versao_contratual_id uuid NOT NULL REFERENCES contrato_versoes(id), revisao integer NOT NULL DEFAULT 1 CHECK(revisao>0),
 criado_por uuid NOT NULL REFERENCES usuarios_administrativos(id), criado_em timestamptz NOT NULL DEFAULT now(), UNIQUE(festa_id,id)
);
CREATE TABLE festa_pendencias (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), festa_id uuid NOT NULL REFERENCES festas(id),
 natureza text NOT NULL CHECK(natureza IN ('CLIENTE','OPERACIONAL')), descricao text NOT NULL CHECK(length(trim(descricao)) BETWEEN 1 AND 4000),
 categoria text NOT NULL DEFAULT 'ANTES' CHECK(categoria IN ('ANTES','DEPOIS')),
 prioridade text NOT NULL CHECK(prioridade IN ('NORMAL','ATENCAO','CRITICA')),
 estado text NOT NULL DEFAULT 'ABERTA' CHECK(estado IN ('ABERTA','EM_TRATAMENTO','RESOLVIDA','NAO_SE_APLICA')),
 area_id uuid REFERENCES festa_areas(id), responsavel_id uuid REFERENCES usuarios_administrativos(id), prazo timestamptz,
 revisao integer NOT NULL DEFAULT 1 CHECK(revisao>0), criado_por uuid NOT NULL REFERENCES usuarios_administrativos(id), criado_em timestamptz NOT NULL DEFAULT now(), UNIQUE(festa_id,id)
);
CREATE TABLE festa_contagens_convidados (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), festa_id uuid NOT NULL REFERENCES festas(id), total_presentes integer NOT NULL CHECK(total_presentes>=0),
 observado_em timestamptz NOT NULL, registrado_em timestamptz NOT NULL DEFAULT now(), sequencia bigint GENERATED ALWAYS AS IDENTITY,
 corrige_contagem_id uuid UNIQUE, motivo text,
 versao_contratual_id uuid NOT NULL REFERENCES contrato_versoes(id), convidados_contratados integer NOT NULL CHECK(convidados_contratados>=0),
 criado_por uuid NOT NULL REFERENCES usuarios_administrativos(id), chave_idempotencia uuid NOT NULL UNIQUE,
 UNIQUE(festa_id,id), FOREIGN KEY(festa_id,corrige_contagem_id) REFERENCES festa_contagens_convidados(festa_id,id),
 CHECK(corrige_contagem_id IS NULL OR (corrige_contagem_id<>id AND length(trim(motivo))>=3))
);
CREATE TABLE festa_solicitacoes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), festa_id uuid NOT NULL REFERENCES festas(id), tipo text NOT NULL CHECK(tipo IN ('HORA_EXTRA','ADICIONAL','ALTERACAO_OPERACIONAL','ALTERACAO_CONTRATUAL')),
 descricao text NOT NULL CHECK(length(trim(descricao)) BETWEEN 1 AND 4000),
 conteudo_solicitado jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(conteudo_solicitado)='object'),
 necessita_contrato boolean NOT NULL, necessita_financeiro boolean NOT NULL,
 contrato_versao_destino_id uuid REFERENCES contrato_versoes(id), pendencia_financeira_id uuid REFERENCES contrato_pendencias_financeiras(id),
 CHECK(necessita_contrato OR contrato_versao_destino_id IS NULL), CHECK(necessita_financeiro OR pendencia_financeira_id IS NULL),
 cancelado_por uuid REFERENCES usuarios_administrativos(id), cancelado_em timestamptz, motivo_cancelamento text,
 versao_contratual_id uuid NOT NULL REFERENCES contrato_versoes(id), revisao integer NOT NULL DEFAULT 1 CHECK(revisao>0),
 criado_por uuid NOT NULL REFERENCES usuarios_administrativos(id), criado_em timestamptz NOT NULL DEFAULT now(), UNIQUE(festa_id,id),
 CHECK((cancelado_por IS NULL AND cancelado_em IS NULL AND motivo_cancelamento IS NULL) OR (cancelado_por IS NOT NULL AND cancelado_em IS NOT NULL AND length(trim(motivo_cancelamento))>=3))
);
CREATE TABLE festa_eventos (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), festa_id uuid NOT NULL REFERENCES festas(id), sequencia bigint GENERATED ALWAYS AS IDENTITY,
 tipo text NOT NULL, entidade_id uuid NOT NULL, usuario_id uuid NOT NULL REFERENCES usuarios_administrativos(id), identidade_snapshot jsonb NOT NULL CHECK(jsonb_typeof(identidade_snapshot)='object'),
 origem_iniciadora text NOT NULL DEFAULT 'FESTA' CHECK(origem_iniciadora IN ('FESTA','CONTRATO','FECHAMENTO','PAGAMENTOS','AGENDA','CRM','SISTEMA')), modulo_executor text NOT NULL DEFAULT 'FESTA',
 request_id uuid NOT NULL, chave_idempotencia uuid NOT NULL UNIQUE, payload_hash text NOT NULL CHECK(payload_hash ~ '^[0-9a-f]{64}$$'),
 versao_contratual_id uuid NOT NULL REFERENCES contrato_versoes(id), dados_antes jsonb, dados_depois jsonb NOT NULL,
 motivo text, ocorrido_em timestamptz NOT NULL DEFAULT now(), criado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX festa_eventos_timeline_idx ON festa_eventos(festa_id,sequencia DESC);
CREATE INDEX festa_tarefas_status_idx ON festa_tarefas(festa_id,estado,categoria);
CREATE INDEX festa_pendencias_status_idx ON festa_pendencias(festa_id,estado,categoria);
CREATE INDEX festa_contagens_instante_idx ON festa_contagens_convidados(festa_id,observado_em DESC,sequencia DESC);
CREATE FUNCTION festa016_imutavel() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Histórico Festa é imutável' USING ERRCODE='23514'; END $$;
CREATE TRIGGER festa_eventos_imutavel BEFORE UPDATE OR DELETE ON festa_eventos FOR EACH ROW EXECUTE FUNCTION festa016_imutavel();
CREATE TRIGGER festa_contagens_imutavel BEFORE UPDATE OR DELETE ON festa_contagens_convidados FOR EACH ROW EXECUTE FUNCTION festa016_imutavel();
CREATE FUNCTION festa016_invalidacao() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Festa deve permanecer no histórico' USING ERRCODE='23514'; END IF;
 IF OLD.invalidada_em IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Festa invalidada é imutável' USING ERRCODE='23514'; END IF;
 IF OLD.invalidada_em IS NULL AND NEW.invalidada_em IS NOT NULL THEN
  IF EXISTS(SELECT 1 FROM festa_eventos WHERE festa_id=OLD.id AND tipo<>'FESTA_CRIADA')
   OR EXISTS(SELECT 1 FROM festa_tarefas WHERE festa_id=OLD.id) OR EXISTS(SELECT 1 FROM festa_pendencias WHERE festa_id=OLD.id)
   OR EXISTS(SELECT 1 FROM festa_contagens_convidados WHERE festa_id=OLD.id)
   OR EXISTS(SELECT 1 FROM festa_solicitacoes WHERE festa_id=OLD.id) OR EXISTS(SELECT 1 FROM festa_buffet WHERE festa_id=OLD.id)
  THEN RAISE EXCEPTION 'Festa possui atividade; não pode ser removida por engano' USING ERRCODE='23514'; END IF;
 END IF; RETURN NEW;
END $$;
CREATE TRIGGER festa_invalidacao_guard BEFORE UPDATE OR DELETE ON festas FOR EACH ROW EXECUTE FUNCTION festa016_invalidacao();
CREATE FUNCTION festa016_bloquear_filho_invalidada() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE invalidada timestamptz;
BEGIN
 SELECT invalidada_em INTO invalidada FROM festas WHERE id=NEW.festa_id FOR UPDATE;
 IF invalidada IS NOT NULL THEN
  IF TG_TABLE_NAME='festa_eventos' THEN
   IF NEW.tipo='FESTA_INVALIDAR' THEN RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION 'Festa invalidada não aceita novos fatos' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER festa_buffet_sem_exclusao BEFORE DELETE ON festa_buffet FOR EACH ROW EXECUTE FUNCTION festa016_imutavel();
CREATE TRIGGER festa_invalidada_buffet BEFORE INSERT OR UPDATE ON festa_buffet FOR EACH ROW EXECUTE FUNCTION festa016_bloquear_filho_invalidada();
CREATE TRIGGER festa_invalidada_tarefas BEFORE INSERT OR UPDATE ON festa_tarefas FOR EACH ROW EXECUTE FUNCTION festa016_bloquear_filho_invalidada();
CREATE TRIGGER festa_invalidada_pendencias BEFORE INSERT OR UPDATE ON festa_pendencias FOR EACH ROW EXECUTE FUNCTION festa016_bloquear_filho_invalidada();
CREATE TRIGGER festa_invalidada_contagens BEFORE INSERT ON festa_contagens_convidados FOR EACH ROW EXECUTE FUNCTION festa016_bloquear_filho_invalidada();
CREATE TRIGGER festa_invalidada_solicitacoes BEFORE INSERT OR UPDATE ON festa_solicitacoes FOR EACH ROW EXECUTE FUNCTION festa016_bloquear_filho_invalidada();
CREATE TRIGGER festa_invalidada_eventos BEFORE INSERT ON festa_eventos FOR EACH ROW EXECUTE FUNCTION festa016_bloquear_filho_invalidada();
CREATE FUNCTION festa016_validar_vinculo() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cid uuid; origem festa_contagens_convidados%ROWTYPE;
BEGIN
 SELECT contrato_id INTO cid FROM festas WHERE id=NEW.festa_id FOR UPDATE;
 IF NOT EXISTS(SELECT 1 FROM contrato_versoes WHERE id=NEW.versao_contratual_id AND contrato_id=cid) THEN RAISE EXCEPTION 'Versão pertence a outra contratação' USING ERRCODE='23514'; END IF;
 IF TG_TABLE_NAME='festa_contagens_convidados' THEN
 IF NEW.corrige_contagem_id IS NOT NULL THEN
   SELECT * INTO origem FROM festa_contagens_convidados WHERE id=NEW.corrige_contagem_id AND festa_id=NEW.festa_id FOR UPDATE;
   IF origem.id IS NULL OR NEW.observado_em<>origem.observado_em THEN RAISE EXCEPTION 'Correção deve preservar instante da observação' USING ERRCODE='23514'; END IF;
 END IF;
 END IF;
 IF TG_TABLE_NAME='festa_solicitacoes' THEN
   IF NEW.contrato_versao_destino_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM contrato_versoes WHERE id=NEW.contrato_versao_destino_id AND contrato_id=cid) THEN RAISE EXCEPTION 'Encaminhamento de outro contrato' USING ERRCODE='23514'; END IF;
   IF NEW.pendencia_financeira_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM contrato_pendencias_financeiras WHERE id=NEW.pendencia_financeira_id AND contrato_id=cid) THEN RAISE EXCEPTION 'Pendência de outro contrato' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER festa_buffet_vinculo BEFORE INSERT OR UPDATE ON festa_buffet FOR EACH ROW EXECUTE FUNCTION festa016_validar_vinculo();
CREATE TRIGGER festa_tarefa_vinculo BEFORE INSERT OR UPDATE ON festa_tarefas FOR EACH ROW EXECUTE FUNCTION festa016_validar_vinculo();
CREATE TRIGGER festa_contagem_vinculo BEFORE INSERT ON festa_contagens_convidados FOR EACH ROW EXECUTE FUNCTION festa016_validar_vinculo();
CREATE TRIGGER festa_solicitacao_vinculo BEFORE INSERT OR UPDATE ON festa_solicitacoes FOR EACH ROW EXECUTE FUNCTION festa016_validar_vinculo();
CREATE TRIGGER festa_evento_vinculo BEFORE INSERT ON festa_eventos FOR EACH ROW EXECUTE FUNCTION festa016_validar_vinculo();
-- CHECK também precisa rejeitar NULL explicitamente nos motivos condicionais.
ALTER TABLE festa_contagens_convidados ADD CONSTRAINT festa_correcao_motivo_obrigatorio CHECK(corrige_contagem_id IS NULL OR motivo IS NOT NULL);
ALTER TABLE festa_usuario_capacidades ADD CONSTRAINT festa_revogacao_motivo_obrigatorio CHECK(revogado_em IS NULL OR motivo_revogacao IS NOT NULL);
ALTER TABLE festa_solicitacoes ADD CONSTRAINT festa_cancelamento_motivo_obrigatorio CHECK(cancelado_em IS NULL OR motivo_cancelamento IS NOT NULL);
ALTER TABLE fechamentos ADD COLUMN buffet_lembrancinha text CHECK(length(buffet_lembrancinha)<=2000), ADD COLUMN buffet_empratado text CHECK(length(buffet_empratado)<=2000), ADD COLUMN buffet_bombom text CHECK(length(buffet_bombom)<=2000);
ALTER TABLE fechamento_revisoes ADD COLUMN buffet_lembrancinha text CHECK(length(buffet_lembrancinha)<=2000), ADD COLUMN buffet_empratado text CHECK(length(buffet_empratado)<=2000), ADD COLUMN buffet_bombom text CHECK(length(buffet_bombom)<=2000);
-- Valores novos nulos são omitidos da projeção para preservar hashes anteriores.
CREATE OR REPLACE FUNCTION kidmais_hash_revisao_operacional(rid uuid) RETURNS text LANGUAGE sql STABLE AS $$
 SELECT encode(sha256(convert_to(jsonb_build_object('schemaVersao',1,'operacao',(jsonb_build_object('cliente_id',r.cliente_id,'responsavel_adicional_id',r.responsavel_adicional_id,'aniversariante_id',r.aniversariante_id,'idade_aniversariante_evento',r.idade_aniversariante_evento,'tema_festa',r.tema_festa,'data_evento',r.data_evento,'horario_inicio',r.horario_inicio,'horario_fim',r.horario_fim,'configuracao_agenda_id',r.configuracao_agenda_id,'pacote_id',r.pacote_id,'tabela_preco_id',r.tabela_preco_id,'preco_pacote_id',r.preco_pacote_id,'regra_desconto_pacote_id',r.regra_desconto_pacote_id,'categoria_horario',r.categoria_horario,'categoria_preco_aplicada',r.categoria_preco_aplicada,'convidados',r.convidados,'convidados_faturados',r.convidados_faturados,'valor_pacote_base',r.valor_pacote_base,'desconto_percentual',r.desconto_percentual,'valor_desconto_pacote',r.valor_desconto_pacote,'valor_pacote_aplicado',r.valor_pacote_aplicado,'valor_adicionais',r.valor_adicionais,'valor_tabela',r.valor_tabela,'valor_negociado',r.valor_negociado,'valor_aprovado',r.valor_aprovado,'motivo_negociacao',r.motivo_negociacao,'observacoes_negociacao',r.observacoes_negociacao,'forma_pagamento_pretendida',r.forma_pagamento_pretendida,'condicao_pagamento',r.condicao_pagamento,'alteracoes_pacote',r.alteracoes_pacote,'observacoes_cliente',r.observacoes_cliente,'observacoes_equipe',r.observacoes_equipe,'usuario_responsavel_id',r.usuario_responsavel_id,'buffet_status',r.buffet_status,'buffet_salgados',r.buffet_salgados,'buffet_bebidas',r.buffet_bebidas,'buffet_doces',r.buffet_doces,'buffet_bolo',r.buffet_bolo,'buffet_outros',r.buffet_outros) || jsonb_strip_nulls(jsonb_build_object('buffet_lembrancinha',r.buffet_lembrancinha,'buffet_empratado',r.buffet_empratado,'buffet_bombom',r.buffet_bombom))),'adicionais',COALESCE((SELECT jsonb_agg(to_jsonb(a)-ARRAY['id','fechamento_id','fechamento_revisao_id','criado_em','atualizado_em'] ORDER BY a.adicional_id) FROM public.fechamento_revisao_adicionais a WHERE a.fechamento_revisao_id=r.id),'[]'::jsonb))::text,'UTF8')),'hex') FROM public.fechamento_revisoes r WHERE r.id=rid;
$$;
CREATE OR REPLACE FUNCTION kidmais_validar_revisao_operacional() RETURNS trigger LANGUAGE plpgsql AS $$
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
   IF (jsonb_build_object('cliente_id',f.cliente_id,'responsavel_adicional_id',f.responsavel_adicional_id,'aniversariante_id',f.aniversariante_id,'idade_aniversariante_evento',f.idade_aniversariante_evento,'tema_festa',f.tema_festa,'data_evento',f.data_evento,'horario_inicio',f.horario_inicio,'horario_fim',f.horario_fim,'configuracao_agenda_id',f.configuracao_agenda_id,'pacote_id',f.pacote_id,'tabela_preco_id',f.tabela_preco_id,'preco_pacote_id',f.preco_pacote_id,'regra_desconto_pacote_id',f.regra_desconto_pacote_id,'categoria_horario',f.categoria_horario,'categoria_preco_aplicada',f.categoria_preco_aplicada,'convidados',f.convidados,'convidados_faturados',f.convidados_faturados,'valor_pacote_base',f.valor_pacote_base,'desconto_percentual',f.desconto_percentual,'valor_desconto_pacote',f.valor_desconto_pacote,'valor_pacote_aplicado',f.valor_pacote_aplicado,'valor_adicionais',f.valor_adicionais,'valor_tabela',f.valor_tabela,'valor_negociado',f.valor_negociado,'valor_aprovado',f.valor_aprovado,'motivo_negociacao',f.motivo_negociacao,'observacoes_negociacao',f.observacoes_negociacao,'forma_pagamento_pretendida',f.forma_pagamento_pretendida,'condicao_pagamento',f.condicao_pagamento,'alteracoes_pacote',f.alteracoes_pacote,'observacoes_cliente',f.observacoes_cliente,'observacoes_equipe',f.observacoes_equipe,'usuario_responsavel_id',f.usuario_responsavel_id,'buffet_status',f.buffet_status,'buffet_salgados',f.buffet_salgados,'buffet_bebidas',f.buffet_bebidas,'buffet_doces',f.buffet_doces,'buffet_bolo',f.buffet_bolo,'buffet_outros',f.buffet_outros) || jsonb_strip_nulls(jsonb_build_object('buffet_lembrancinha',f.buffet_lembrancinha,'buffet_empratado',f.buffet_empratado,'buffet_bombom',f.buffet_bombom))) IS DISTINCT FROM (jsonb_build_object('cliente_id',r.cliente_id,'responsavel_adicional_id',r.responsavel_adicional_id,'aniversariante_id',r.aniversariante_id,'idade_aniversariante_evento',r.idade_aniversariante_evento,'tema_festa',r.tema_festa,'data_evento',r.data_evento,'horario_inicio',r.horario_inicio,'horario_fim',r.horario_fim,'configuracao_agenda_id',r.configuracao_agenda_id,'pacote_id',r.pacote_id,'tabela_preco_id',r.tabela_preco_id,'preco_pacote_id',r.preco_pacote_id,'regra_desconto_pacote_id',r.regra_desconto_pacote_id,'categoria_horario',r.categoria_horario,'categoria_preco_aplicada',r.categoria_preco_aplicada,'convidados',r.convidados,'convidados_faturados',r.convidados_faturados,'valor_pacote_base',r.valor_pacote_base,'desconto_percentual',r.desconto_percentual,'valor_desconto_pacote',r.valor_desconto_pacote,'valor_pacote_aplicado',r.valor_pacote_aplicado,'valor_adicionais',r.valor_adicionais,'valor_tabela',r.valor_tabela,'valor_negociado',r.valor_negociado,'valor_aprovado',r.valor_aprovado,'motivo_negociacao',r.motivo_negociacao,'observacoes_negociacao',r.observacoes_negociacao,'forma_pagamento_pretendida',r.forma_pagamento_pretendida,'condicao_pagamento',r.condicao_pagamento,'alteracoes_pacote',r.alteracoes_pacote,'observacoes_cliente',r.observacoes_cliente,'observacoes_equipe',r.observacoes_equipe,'usuario_responsavel_id',r.usuario_responsavel_id,'buffet_status',r.buffet_status,'buffet_salgados',r.buffet_salgados,'buffet_bebidas',r.buffet_bebidas,'buffet_doces',r.buffet_doces,'buffet_bolo',r.buffet_bolo,'buffet_outros',r.buffet_outros) || jsonb_strip_nulls(jsonb_build_object('buffet_lembrancinha',r.buffet_lembrancinha,'buffet_empratado',r.buffet_empratado,'buffet_bombom',r.buffet_bombom))) OR (SELECT COALESCE(jsonb_agg(to_jsonb(a)-ARRAY['id','fechamento_id','fechamento_revisao_id','criado_em','atualizado_em'] ORDER BY a.adicional_id),'[]'::jsonb) FROM public.fechamento_adicionais a WHERE a.fechamento_id=f.id) IS DISTINCT FROM (SELECT COALESCE(jsonb_agg(to_jsonb(a)-ARRAY['id','fechamento_id','fechamento_revisao_id','criado_em','atualizado_em'] ORDER BY a.adicional_id),'[]'::jsonb) FROM public.fechamento_revisao_adicionais a WHERE a.fechamento_revisao_id=r.id) THEN RAISE EXCEPTION 'Operação não aplicada integralmente' USING ERRCODE='23514'; END IF;
  END IF;
 END IF;
 RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION kidmais_proteger_fechamento_em_revisao() RETURNS trigger LANGUAGE plpgsql AS $$
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
 SELECT encode(sha256(convert_to(jsonb_build_object('schemaVersao',1,'operacao',(jsonb_build_object('cliente_id',f.cliente_id,'responsavel_adicional_id',f.responsavel_adicional_id,'aniversariante_id',f.aniversariante_id,'idade_aniversariante_evento',f.idade_aniversariante_evento,'tema_festa',f.tema_festa,'data_evento',f.data_evento,'horario_inicio',f.horario_inicio,'horario_fim',f.horario_fim,'configuracao_agenda_id',f.configuracao_agenda_id,'pacote_id',f.pacote_id,'tabela_preco_id',f.tabela_preco_id,'preco_pacote_id',f.preco_pacote_id,'regra_desconto_pacote_id',f.regra_desconto_pacote_id,'categoria_horario',f.categoria_horario,'categoria_preco_aplicada',f.categoria_preco_aplicada,'convidados',f.convidados,'convidados_faturados',f.convidados_faturados,'valor_pacote_base',f.valor_pacote_base,'desconto_percentual',f.desconto_percentual,'valor_desconto_pacote',f.valor_desconto_pacote,'valor_pacote_aplicado',f.valor_pacote_aplicado,'valor_adicionais',f.valor_adicionais,'valor_tabela',f.valor_tabela,'valor_negociado',f.valor_negociado,'valor_aprovado',f.valor_aprovado,'motivo_negociacao',f.motivo_negociacao,'observacoes_negociacao',f.observacoes_negociacao,'forma_pagamento_pretendida',f.forma_pagamento_pretendida,'condicao_pagamento',f.condicao_pagamento,'alteracoes_pacote',f.alteracoes_pacote,'observacoes_cliente',f.observacoes_cliente,'observacoes_equipe',f.observacoes_equipe,'usuario_responsavel_id',f.usuario_responsavel_id,'buffet_status',f.buffet_status,'buffet_salgados',f.buffet_salgados,'buffet_bebidas',f.buffet_bebidas,'buffet_doces',f.buffet_doces,'buffet_bolo',f.buffet_bolo,'buffet_outros',f.buffet_outros) || jsonb_strip_nulls(jsonb_build_object('buffet_lembrancinha',f.buffet_lembrancinha,'buffet_empratado',f.buffet_empratado,'buffet_bombom',f.buffet_bombom))),'adicionais',COALESCE((SELECT jsonb_agg(to_jsonb(a)-ARRAY['id','fechamento_id','fechamento_revisao_id','criado_em','atualizado_em'] ORDER BY a.adicional_id) FROM public.fechamento_adicionais a WHERE a.fechamento_id=f.id),'[]'::jsonb),'versaoBaseId',r.versao_base_id,'snapshotBaseHash',(SELECT snapshot_hash FROM public.contrato_versoes WHERE id=r.versao_base_id))::text,'UTF8')),'hex') INTO h;
 IF h IS DISTINCT FROM r.fonte_base_hash THEN RAISE EXCEPTION 'Fechamento vigente mudou durante preparação' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
COMMIT;
