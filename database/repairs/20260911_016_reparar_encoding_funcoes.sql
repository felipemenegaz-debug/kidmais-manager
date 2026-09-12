-- Reparo operacional 016; nao e migration. Arquivo UTF-8 sem BOM.
-- Fonte exclusiva: pg_get_functiondef do clone canonico kidmais_016_1789127372077.
-- Executar futuramente com psql -X -v ON_ERROR_STOP=1 -f e PGCLIENTENCODING=UTF8.
-- Nao autorizado no banco real nesta etapa. Nao enviar por pipeline de texto.
BEGIN;
SET LOCAL client_encoding = 'UTF8';
SET LOCAL search_path = public;
DO $guarda_reparo_016$
DECLARE atual text;
BEGIN
 SELECT assinatura INTO atual FROM (
WITH tabelas AS (
 SELECT c.oid,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND c.relkind='r' AND c.relname=ANY(ARRAY['festas','festa_areas','festa_usuario_capacidades','festa_tarefas','festa_pendencias','festa_buffet','festa_contagens_convidados','festa_solicitacoes','festa_eventos']::text[])
), colunas AS (
 SELECT c.relname,a.attname,format_type(a.atttypid,a.atttypmod) tipo,a.attnotnull,a.attidentity,
 pg_get_expr(d.adbin,d.adrelid) valor_padrao
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
 LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
 WHERE n.nspname='public' AND a.attnum>0 AND NOT a.attisdropped
 AND (c.relname=ANY(ARRAY['festas','festa_areas','festa_usuario_capacidades','festa_tarefas','festa_pendencias','festa_buffet','festa_contagens_convidados','festa_solicitacoes','festa_eventos']::text[]) OR (c.relname IN ('fechamentos','fechamento_revisoes') AND a.attname IN ('buffet_lembrancinha','buffet_empratado','buffet_bombom')))
), restricoes AS (
 SELECT r.relname,c.conname,c.contype,c.convalidated,c.condeferrable,c.condeferred,pg_get_constraintdef(c.oid) definicao
 FROM pg_constraint c JOIN pg_class r ON r.oid=c.conrelid JOIN pg_namespace n ON n.oid=r.relnamespace
 WHERE n.nspname='public' AND (r.relname=ANY(ARRAY['festas','festa_areas','festa_usuario_capacidades','festa_tarefas','festa_pendencias','festa_buffet','festa_contagens_convidados','festa_solicitacoes','festa_eventos']::text[]) OR (r.relname IN ('fechamentos','fechamento_revisoes') AND c.conname IN ('fechamentos_buffet_lembrancinha_check','fechamentos_buffet_empratado_check','fechamentos_buffet_bombom_check','fechamento_revisoes_buffet_lembrancinha_check','fechamento_revisoes_buffet_empratado_check','fechamento_revisoes_buffet_bombom_check')))
), indices AS (
 SELECT t.relname,c.relname nome,i.indisunique,i.indisvalid,i.indisready,pg_get_indexdef(i.indexrelid) definicao
 FROM pg_index i JOIN tabelas t ON t.oid=i.indrelid JOIN pg_class c ON c.oid=i.indexrelid
), gatilhos AS (
 SELECT t.relname,g.tgname,g.tgenabled,pg_get_triggerdef(g.oid) definicao FROM pg_trigger g JOIN tabelas t ON t.oid=g.tgrelid WHERE NOT g.tgisinternal
), funcoes AS (
 SELECT p.proname,pg_get_functiondef(p.oid) definicao FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.prokind='f' AND (p.proname LIKE 'festa016_%' OR p.proname IN ('kidmais_hash_revisao_operacional','kidmais_validar_revisao_operacional','kidmais_proteger_fechamento_em_revisao'))
), contrato AS (
 SELECT jsonb_build_object(
 'tabelas',(SELECT jsonb_agg(relname ORDER BY relname) FROM tabelas),
 'colunas',(SELECT jsonb_agg(to_jsonb(c) ORDER BY relname,attname) FROM colunas c),
 'restricoes',(SELECT jsonb_agg(to_jsonb(c) ORDER BY relname,conname) FROM restricoes c),
 'indices',(SELECT jsonb_agg(to_jsonb(i) ORDER BY relname,nome) FROM indices i),
 'gatilhos',(SELECT jsonb_agg(to_jsonb(g) ORDER BY relname,tgname) FROM gatilhos g),
 'funcoes',(SELECT jsonb_agg(to_jsonb(f) ORDER BY proname,definicao) FROM funcoes f),
 'estrutura_descartada',to_regclass('public.festa_ocorrencias') IS NOT NULL
 ) AS documento
)
SELECT encode(sha256(convert_to(documento::text,'UTF8')),'hex') assinatura FROM contrato) AS assinatura_016;
 IF atual IS NULL OR atual NOT IN ('d723f81def59be627132230aa6de2e00b0b509d48f20b0e0701afd7eb99650d7','f4ed68abf6e44dffb643cc618f0a22561c39e717e5637e032bab175019e43f55') THEN
  RAISE EXCEPTION 'Reparo 016 recusado: divergencia inicial nao prevista' USING ERRCODE='23514';
 END IF;
END
$guarda_reparo_016$;

-- INICIO DEFINICOES CANONICAS
CREATE OR REPLACE FUNCTION public.festa016_bloquear_filho_invalidada()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
END $function$
;

CREATE OR REPLACE FUNCTION public.festa016_imutavel()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN RAISE EXCEPTION 'Histórico Festa é imutável' USING ERRCODE='23514'; END $function$
;

CREATE OR REPLACE FUNCTION public.festa016_invalidacao()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
END $function$
;

CREATE OR REPLACE FUNCTION public.festa016_validar_vinculo()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
END $function$
;

CREATE OR REPLACE FUNCTION public.kidmais_proteger_fechamento_em_revisao()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
END $function$
;

CREATE OR REPLACE FUNCTION public.kidmais_validar_revisao_operacional()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
END $function$
;

-- FIM DEFINICOES CANONICAS
DO $guarda_reparo_016$
DECLARE atual text;
BEGIN
 SELECT assinatura INTO atual FROM (
WITH tabelas AS (
 SELECT c.oid,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND c.relkind='r' AND c.relname=ANY(ARRAY['festas','festa_areas','festa_usuario_capacidades','festa_tarefas','festa_pendencias','festa_buffet','festa_contagens_convidados','festa_solicitacoes','festa_eventos']::text[])
), colunas AS (
 SELECT c.relname,a.attname,format_type(a.atttypid,a.atttypmod) tipo,a.attnotnull,a.attidentity,
 pg_get_expr(d.adbin,d.adrelid) valor_padrao
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
 LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
 WHERE n.nspname='public' AND a.attnum>0 AND NOT a.attisdropped
 AND (c.relname=ANY(ARRAY['festas','festa_areas','festa_usuario_capacidades','festa_tarefas','festa_pendencias','festa_buffet','festa_contagens_convidados','festa_solicitacoes','festa_eventos']::text[]) OR (c.relname IN ('fechamentos','fechamento_revisoes') AND a.attname IN ('buffet_lembrancinha','buffet_empratado','buffet_bombom')))
), restricoes AS (
 SELECT r.relname,c.conname,c.contype,c.convalidated,c.condeferrable,c.condeferred,pg_get_constraintdef(c.oid) definicao
 FROM pg_constraint c JOIN pg_class r ON r.oid=c.conrelid JOIN pg_namespace n ON n.oid=r.relnamespace
 WHERE n.nspname='public' AND (r.relname=ANY(ARRAY['festas','festa_areas','festa_usuario_capacidades','festa_tarefas','festa_pendencias','festa_buffet','festa_contagens_convidados','festa_solicitacoes','festa_eventos']::text[]) OR (r.relname IN ('fechamentos','fechamento_revisoes') AND c.conname IN ('fechamentos_buffet_lembrancinha_check','fechamentos_buffet_empratado_check','fechamentos_buffet_bombom_check','fechamento_revisoes_buffet_lembrancinha_check','fechamento_revisoes_buffet_empratado_check','fechamento_revisoes_buffet_bombom_check')))
), indices AS (
 SELECT t.relname,c.relname nome,i.indisunique,i.indisvalid,i.indisready,pg_get_indexdef(i.indexrelid) definicao
 FROM pg_index i JOIN tabelas t ON t.oid=i.indrelid JOIN pg_class c ON c.oid=i.indexrelid
), gatilhos AS (
 SELECT t.relname,g.tgname,g.tgenabled,pg_get_triggerdef(g.oid) definicao FROM pg_trigger g JOIN tabelas t ON t.oid=g.tgrelid WHERE NOT g.tgisinternal
), funcoes AS (
 SELECT p.proname,pg_get_functiondef(p.oid) definicao FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.prokind='f' AND (p.proname LIKE 'festa016_%' OR p.proname IN ('kidmais_hash_revisao_operacional','kidmais_validar_revisao_operacional','kidmais_proteger_fechamento_em_revisao'))
), contrato AS (
 SELECT jsonb_build_object(
 'tabelas',(SELECT jsonb_agg(relname ORDER BY relname) FROM tabelas),
 'colunas',(SELECT jsonb_agg(to_jsonb(c) ORDER BY relname,attname) FROM colunas c),
 'restricoes',(SELECT jsonb_agg(to_jsonb(c) ORDER BY relname,conname) FROM restricoes c),
 'indices',(SELECT jsonb_agg(to_jsonb(i) ORDER BY relname,nome) FROM indices i),
 'gatilhos',(SELECT jsonb_agg(to_jsonb(g) ORDER BY relname,tgname) FROM gatilhos g),
 'funcoes',(SELECT jsonb_agg(to_jsonb(f) ORDER BY proname,definicao) FROM funcoes f),
 'estrutura_descartada',to_regclass('public.festa_ocorrencias') IS NOT NULL
 ) AS documento
)
SELECT encode(sha256(convert_to(documento::text,'UTF8')),'hex') assinatura FROM contrato) AS assinatura_016;
 IF atual IS DISTINCT FROM 'd723f81def59be627132230aa6de2e00b0b509d48f20b0e0701afd7eb99650d7' THEN
  RAISE EXCEPTION 'Reparo 016 recusado: assinatura final nao canonica' USING ERRCODE='23514';
 END IF;
END
$guarda_reparo_016$;
COMMIT;
