-- Autorizada após PROPOSTA_CONTRATO_AUTENTICACAO_VERSIONAMENTO.md.
-- Sem backfill, seed, importação de PDF, credencial ou alteração da Migration 012.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = public, pg_catalog;

CREATE TABLE usuarios_administrativos (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text NOT NULL,
 nome text NOT NULL, cargo text, senha_hash text NOT NULL,
 papel varchar(32) NOT NULL, ativo boolean NOT NULL DEFAULT true,
 senha_alterada_em timestamptz NOT NULL DEFAULT now(),
 criado_em timestamptz NOT NULL DEFAULT now(), atualizado_em timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT usuarios_administrativos_email_check CHECK(email=lower(btrim(email)) AND email<>''),
 CONSTRAINT usuarios_administrativos_nome_check CHECK(btrim(nome)<>'' AND (cargo IS NULL OR btrim(cargo)<>'')),
 CONSTRAINT usuarios_administrativos_papel_check CHECK(papel IN ('ADMINISTRATIVO','REPRESENTANTE_AUTORIZADO')),
 CONSTRAINT usuarios_administrativos_senha_check CHECK(senha_hash ~ '^scrypt\$v=1\$N=131072\$r=8\$p=1\$[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{86}==$')
);
CREATE UNIQUE INDEX usuarios_administrativos_email_uk ON usuarios_administrativos(lower(btrim(email)));
CREATE TRIGGER usuarios_administrativos_atualizado_em_trg BEFORE UPDATE ON usuarios_administrativos FOR EACH ROW EXECUTE FUNCTION kidmais_set_atualizado_em();

CREATE TABLE sessoes_administrativas (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 usuario_id uuid NOT NULL REFERENCES usuarios_administrativos(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 token_hash char(64) NOT NULL UNIQUE, csrf_hash char(64) NOT NULL,
 criado_em timestamptz NOT NULL DEFAULT now(), autenticado_em timestamptz NOT NULL,
 ultima_atividade_em timestamptz NOT NULL, expira_em timestamptz NOT NULL,
 revogado_em timestamptz, ip inet, user_agent text,
 CONSTRAINT sessoes_administrativas_hashes_check CHECK(token_hash ~ '^[0-9a-f]{64}$' AND csrf_hash ~ '^[0-9a-f]{64}$'),
 CONSTRAINT sessoes_administrativas_datas_check CHECK(expira_em>criado_em AND autenticado_em>=criado_em AND ultima_atividade_em>=criado_em AND (revogado_em IS NULL OR revogado_em>=criado_em))
);
CREATE INDEX sessoes_administrativas_usuario_expira_idx ON sessoes_administrativas(usuario_id,expira_em);
CREATE INDEX sessoes_administrativas_expira_idx ON sessoes_administrativas(expira_em);

CREATE TABLE limites_autenticacao (
 chave_hash char(64) PRIMARY KEY, tipo varchar(16) NOT NULL,
 tentativas integer NOT NULL DEFAULT 0, janela_iniciada_em timestamptz NOT NULL,
 bloqueado_ate timestamptz, atualizado_em timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT limites_autenticacao_dados_check CHECK(chave_hash ~ '^[0-9a-f]{64}$' AND tipo IN ('IDENTIFICADOR','ORIGEM') AND tentativas>=0),
 CONSTRAINT limites_autenticacao_datas_check CHECK(atualizado_em>=janela_iniciada_em AND (bloqueado_ate IS NULL OR bloqueado_ate>=janela_iniciada_em))
);
CREATE INDEX limites_autenticacao_atualizado_idx ON limites_autenticacao(atualizado_em);
CREATE TRIGGER limites_autenticacao_atualizado_em_trg BEFORE UPDATE ON limites_autenticacao FOR EACH ROW EXECUTE FUNCTION kidmais_set_atualizado_em();

ALTER TABLE contrato_versoes ADD CONSTRAINT contrato_versoes_contrato_id_id_uk UNIQUE(contrato_id,id);
DROP INDEX contrato_versoes_corrente_uk;
CREATE UNIQUE INDEX contrato_versoes_em_preparacao_uk ON contrato_versoes(contrato_id) WHERE status='ATIVA';

CREATE TABLE contrato_fluxos (
 contrato_id uuid PRIMARY KEY REFERENCES contratos(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 versao_em_preparacao_id uuid, versao_vigente_id uuid,
 criado_em timestamptz NOT NULL DEFAULT now(), atualizado_em timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT contrato_fluxos_preparacao_fk FOREIGN KEY(contrato_id,versao_em_preparacao_id) REFERENCES contrato_versoes(contrato_id,id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT contrato_fluxos_vigente_fk FOREIGN KEY(contrato_id,versao_vigente_id) REFERENCES contrato_versoes(contrato_id,id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT contrato_fluxos_distintas_check CHECK(versao_em_preparacao_id IS NULL OR versao_vigente_id IS NULL OR versao_em_preparacao_id<>versao_vigente_id)
);
CREATE TRIGGER contrato_fluxos_atualizado_em_trg BEFORE UPDATE ON contrato_fluxos FOR EACH ROW EXECUTE FUNCTION kidmais_set_atualizado_em();

CREATE TABLE contrato_documentos (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 contrato_versao_id uuid NOT NULL REFERENCES contrato_versoes(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 categoria varchar(24) NOT NULL, revisao integer NOT NULL, snapshot_hash char(64) NOT NULL,
 template_codigo text NOT NULL, template_versao integer NOT NULL, pdf_hash char(64) NOT NULL,
 tamanho_bytes bigint NOT NULL, conteudo_pdf bytea NOT NULL,
 gerado_por_usuario_id uuid REFERENCES usuarios_administrativos(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 criado_em timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT contrato_documentos_versao_id_id_uk UNIQUE(contrato_versao_id,id),
 CONSTRAINT contrato_documentos_categoria_check CHECK(categoria IN ('CONTRATO','COMPROVANTE_ASSINATURA')),
 CONSTRAINT contrato_documentos_revisao_check CHECK(revisao>0),
 CONSTRAINT contrato_documentos_template_check CHECK(template_versao>0 AND btrim(template_codigo)<>''),
 CONSTRAINT contrato_documentos_hashes_check CHECK(snapshot_hash ~ '^[0-9a-f]{64}$' AND pdf_hash ~ '^[0-9a-f]{64}$'),
 CONSTRAINT contrato_documentos_tamanho_check CHECK(tamanho_bytes>0 AND tamanho_bytes=octet_length(conteudo_pdf)),
 CONSTRAINT contrato_documentos_conteudo_hash_check CHECK(pdf_hash=encode(sha256(conteudo_pdf),'hex')),
 CONSTRAINT contrato_documentos_autoria_check CHECK(categoria<>'CONTRATO' OR gerado_por_usuario_id IS NOT NULL)
);
CREATE INDEX contrato_documentos_versao_criado_idx ON contrato_documentos(contrato_versao_id,criado_em);

CREATE TABLE contrato_edicoes (
 contrato_versao_id uuid PRIMARY KEY, contrato_id uuid NOT NULL, origem_versao_id uuid,
 tipo varchar(20) NOT NULL, estado varchar(32) NOT NULL, revisao integer NOT NULL DEFAULT 1,
 dados_fonte jsonb NOT NULL, alteracoes jsonb NOT NULL,
 revisao_comercial_aprovada integer,
 aprovado_comercial_por_usuario_id uuid REFERENCES usuarios_administrativos(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 aprovado_comercial_em timestamptz, documento_revisado_id uuid,
 revisado_por_usuario_id uuid REFERENCES usuarios_administrativos(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 revisado_em timestamptz,
 liberado_por_usuario_id uuid REFERENCES usuarios_administrativos(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 liberado_em timestamptz,
 criado_por_usuario_id uuid NOT NULL REFERENCES usuarios_administrativos(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 atualizado_por_usuario_id uuid NOT NULL REFERENCES usuarios_administrativos(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 criado_em timestamptz NOT NULL DEFAULT now(), atualizado_em timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT contrato_edicoes_versao_fk FOREIGN KEY(contrato_id,contrato_versao_id) REFERENCES contrato_versoes(contrato_id,id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT contrato_edicoes_origem_fk FOREIGN KEY(contrato_id,origem_versao_id) REFERENCES contrato_versoes(contrato_id,id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT contrato_edicoes_documento_fk FOREIGN KEY(contrato_versao_id,documento_revisado_id) REFERENCES contrato_documentos(contrato_versao_id,id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT contrato_edicoes_tipo_check CHECK((tipo='INICIAL' AND origem_versao_id IS NULL) OR (tipo IN ('NOVA_VERSAO','RETIFICACAO','ADITIVO') AND origem_versao_id IS NOT NULL AND origem_versao_id<>contrato_versao_id)),
 CONSTRAINT contrato_edicoes_estado_check CHECK(estado IN ('EM_ELABORACAO','ASSINADA_KIDMAIS','AGUARDANDO_CLIENTE','CONCLUIDA','CANCELADA')),
 CONSTRAINT contrato_edicoes_fonte_check CHECK(revisao>0 AND jsonb_typeof(dados_fonte)='object' AND COALESCE(dados_fonte->'schemaVersao'='1'::jsonb,false) AND jsonb_typeof(alteracoes)='object'),
 CONSTRAINT contrato_edicoes_aprovacao_check CHECK(num_nonnulls(revisao_comercial_aprovada,aprovado_comercial_por_usuario_id,aprovado_comercial_em)=0 OR (num_nonnulls(revisao_comercial_aprovada,aprovado_comercial_por_usuario_id,aprovado_comercial_em)=3 AND revisao_comercial_aprovada>0 AND revisao_comercial_aprovada<=revisao)),
 CONSTRAINT contrato_edicoes_revisao_check CHECK(num_nonnulls(documento_revisado_id,revisado_por_usuario_id,revisado_em) IN (0,3)),
 CONSTRAINT contrato_edicoes_liberacao_check CHECK(num_nonnulls(liberado_por_usuario_id,liberado_em) IN (0,2))
);
CREATE INDEX contrato_edicoes_contrato_criado_idx ON contrato_edicoes(contrato_id,criado_em);
CREATE INDEX contrato_edicoes_origem_idx ON contrato_edicoes(origem_versao_id);
CREATE TRIGGER contrato_edicoes_atualizado_em_trg BEFORE UPDATE ON contrato_edicoes FOR EACH ROW EXECUTE FUNCTION kidmais_set_atualizado_em();

CREATE TABLE contrato_assinaturas (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 contrato_versao_id uuid NOT NULL REFERENCES contrato_versoes(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 parte varchar(12) NOT NULL, documento_id uuid NOT NULL,
 usuario_id uuid REFERENCES usuarios_administrativos(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 sessao_id uuid, autenticacao_metodo varchar(24), autenticado_em timestamptz,
 validacao_identidade_id uuid REFERENCES validacoes_identidade_cliente(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 identidade_snapshot jsonb NOT NULL, snapshot_hash char(64) NOT NULL, pdf_hash char(64) NOT NULL,
 metodo varchar(24) NOT NULL, provider varchar(24) NOT NULL, assinado_em timestamptz NOT NULL,
 ip inet, user_agent text, request_id uuid NOT NULL, chave_idempotencia uuid NOT NULL,
 comprovante_documento_id uuid NOT NULL,
 CONSTRAINT contrato_assinaturas_parte_uk UNIQUE(contrato_versao_id,parte),
 CONSTRAINT contrato_assinaturas_idempotencia_uk UNIQUE(parte,chave_idempotencia),
 CONSTRAINT contrato_assinaturas_documento_fk FOREIGN KEY(contrato_versao_id,documento_id) REFERENCES contrato_documentos(contrato_versao_id,id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT contrato_assinaturas_comprovante_fk FOREIGN KEY(contrato_versao_id,comprovante_documento_id) REFERENCES contrato_documentos(contrato_versao_id,id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT contrato_assinaturas_hashes_check CHECK(snapshot_hash ~ '^[0-9a-f]{64}$' AND pdf_hash ~ '^[0-9a-f]{64}$' AND jsonb_typeof(identidade_snapshot)='object'),
 CONSTRAINT contrato_assinaturas_contexto_check CHECK(provider='INTERNAL' AND (
  (parte='KIDMAIS' AND usuario_id IS NOT NULL AND sessao_id IS NOT NULL AND autenticacao_metodo IS NOT NULL AND autenticacao_metodo='SENHA' AND autenticado_em IS NOT NULL AND metodo='SESSAO_REAUTENTICADA' AND validacao_identidade_id IS NULL AND autenticado_em<=assinado_em AND assinado_em-autenticado_em<=interval '5 minutes' AND COALESCE(identidade_snapshot->>'usuarioId'=usuario_id::text AND identidade_snapshot->>'papel'='REPRESENTANTE_AUTORIZADO' AND btrim(identidade_snapshot->>'nome')<>'' AND identidade_snapshot ? 'cargo',false))
  OR (parte='CLIENTE' AND validacao_identidade_id IS NOT NULL AND metodo='OTP' AND num_nonnulls(usuario_id,sessao_id,autenticacao_metodo,autenticado_em)=0)))
);
COMMENT ON COLUMN contrato_assinaturas.sessao_id IS 'UUID histórico sem FK. Validação da sessão ocorre no INSERT; retenção não altera prova.';
CREATE INDEX contrato_assinaturas_sessao_idx ON contrato_assinaturas(sessao_id);
CREATE INDEX contrato_assinaturas_validacao_idx ON contrato_assinaturas(validacao_identidade_id);

CREATE TABLE contrato_pendencias_financeiras (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 contrato_id uuid NOT NULL REFERENCES contratos(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 versao_anterior_id uuid NOT NULL, versao_nova_id uuid NOT NULL,
 pagamento_id uuid NOT NULL REFERENCES pagamentos(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 motivo text NOT NULL, diferencas jsonb NOT NULL, criado_em timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT contrato_pendencias_financeiras_pagamento_versao_uk UNIQUE(pagamento_id,versao_nova_id),
 CONSTRAINT contrato_pendencias_financeiras_anterior_fk FOREIGN KEY(contrato_id,versao_anterior_id) REFERENCES contrato_versoes(contrato_id,id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT contrato_pendencias_financeiras_nova_fk FOREIGN KEY(contrato_id,versao_nova_id) REFERENCES contrato_versoes(contrato_id,id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT contrato_pendencias_financeiras_dados_check CHECK(versao_anterior_id<>versao_nova_id AND btrim(motivo)<>'' AND jsonb_typeof(diferencas)='object')
);
CREATE INDEX contrato_pendencias_financeiras_contrato_idx ON contrato_pendencias_financeiras(contrato_id,criado_em);
CREATE INDEX contrato_pendencias_financeiras_anterior_idx ON contrato_pendencias_financeiras(versao_anterior_id);
CREATE INDEX contrato_pendencias_financeiras_nova_idx ON contrato_pendencias_financeiras(versao_nova_id);

CREATE FUNCTION kidmais_bloquear_mutacao_prova_contrato() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Prova/documento/pendência contratual imutável' USING ERRCODE='23514'; END $$;
CREATE TRIGGER contrato_documentos_imutavel_trg BEFORE UPDATE OR DELETE ON contrato_documentos FOR EACH ROW EXECUTE FUNCTION kidmais_bloquear_mutacao_prova_contrato();
CREATE TRIGGER contrato_assinaturas_imutavel_trg BEFORE UPDATE OR DELETE ON contrato_assinaturas FOR EACH ROW EXECUTE FUNCTION kidmais_bloquear_mutacao_prova_contrato();
CREATE TRIGGER contrato_pendencias_financeiras_imutavel_trg BEFORE UPDATE OR DELETE ON contrato_pendencias_financeiras FOR EACH ROW EXECUTE FUNCTION kidmais_bloquear_mutacao_prova_contrato();

CREATE FUNCTION kidmais_preservar_versao_assinada() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.status='ASSINADA' THEN RAISE EXCEPTION 'Versão assinada é imutável' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM contrato_assinaturas WHERE contrato_versao_id=OLD.id) THEN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Versão com prova não pode ser excluída' USING ERRCODE='23514'; END IF;
  IF (to_jsonb(NEW)-ARRAY['status','assinado_em','documento_template_versao','documento_pdf_hash','aceite_metodo']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','assinado_em','documento_template_versao','documento_pdf_hash','aceite_metodo']) THEN
   RAISE EXCEPTION 'Conteúdo da versão congelado' USING ERRCODE='23514';
  END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
CREATE TRIGGER contrato_versoes_preservar_assinada_trg BEFORE UPDATE OR DELETE ON contrato_versoes FOR EACH ROW EXECUTE FUNCTION kidmais_preservar_versao_assinada();

CREATE FUNCTION kidmais_preservar_edicao_contrato() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Histórico de edição não pode ser excluído' USING ERRCODE='23514'; END IF;
 IF OLD.estado IN ('CONCLUIDA','CANCELADA') THEN RAISE EXCEPTION 'Edição encerrada é imutável' USING ERRCODE='23514'; END IF;
 IF OLD.estado<>'EM_ELABORACAO' OR EXISTS(SELECT 1 FROM contrato_assinaturas WHERE contrato_versao_id=OLD.contrato_versao_id) THEN
  IF (to_jsonb(NEW)-ARRAY['estado','liberado_por_usuario_id','liberado_em','atualizado_por_usuario_id','atualizado_em']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['estado','liberado_por_usuario_id','liberado_em','atualizado_por_usuario_id','atualizado_em']) THEN
   RAISE EXCEPTION 'Edição assinada congelada' USING ERRCODE='23514';
  END IF;
 END IF;
 IF NOT (NEW.estado=OLD.estado OR
  (OLD.estado='EM_ELABORACAO' AND NEW.estado IN ('ASSINADA_KIDMAIS','CANCELADA')) OR
  (OLD.estado='ASSINADA_KIDMAIS' AND NEW.estado IN ('AGUARDANDO_CLIENTE','CANCELADA')) OR
  (OLD.estado='AGUARDANDO_CLIENTE' AND NEW.estado IN ('CONCLUIDA','CANCELADA'))) THEN
  RAISE EXCEPTION 'Transição de edição inválida' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER contrato_edicoes_preservar_trg BEFORE UPDATE OR DELETE ON contrato_edicoes FOR EACH ROW EXECUTE FUNCTION kidmais_preservar_edicao_contrato();

CREATE FUNCTION kidmais_validar_fluxo_contrato() RETURNS trigger LANGUAGE plpgsql AS $$
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
   IF u.id IS NULL OR NOT u.ativo OR u.papel<>'REPRESENTANTE_AUTORIZADO' OR s.id IS NULL OR s.usuario_id<>u.id OR s.revogado_em IS NOT NULL OR s.expira_em<=clock_timestamp() OR s.ultima_atividade_em<=clock_timestamp()-interval '30 minutes' OR s.autenticado_em<clock_timestamp()-interval '5 minutes' OR NEW.autenticado_em<>s.autenticado_em OR NEW.identidade_snapshot->>'nome' IS DISTINCT FROM u.nome OR NEW.identidade_snapshot->>'cargo' IS DISTINCT FROM u.cargo THEN RAISE EXCEPTION 'Sessão/identidade de assinatura inválida' USING ERRCODE='23514'; END IF;
  ELSE
   SELECT * INTO prova FROM validacoes_identidade_cliente WHERE id=NEW.validacao_identidade_id;
   IF prova.id IS NULL OR prova.finalidade<>'CONTRATO_ACEITE' OR prova.status<>'CONSUMIDA' OR prova.consumido_por_contrato_versao_id IS DISTINCT FROM vid THEN RAISE EXCEPTION 'OTP inválido para assinatura' USING ERRCODE='23514'; END IF;
  END IF;
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER contrato_versoes_validar_fluxo_trg AFTER INSERT OR UPDATE ON contrato_versoes DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kidmais_validar_fluxo_contrato();
CREATE CONSTRAINT TRIGGER contrato_fluxos_validar_trg AFTER INSERT OR UPDATE ON contrato_fluxos DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kidmais_validar_fluxo_contrato();
CREATE CONSTRAINT TRIGGER contrato_edicoes_validar_trg AFTER INSERT OR UPDATE ON contrato_edicoes DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kidmais_validar_fluxo_contrato();
CREATE CONSTRAINT TRIGGER contrato_assinaturas_validar_trg AFTER INSERT ON contrato_assinaturas DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kidmais_validar_fluxo_contrato();
COMMIT;
