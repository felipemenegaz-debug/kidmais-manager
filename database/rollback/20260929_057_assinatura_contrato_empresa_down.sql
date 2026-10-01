-- Rollback da 057. Recusa quando perderia informação: capability concedida ou revogada depois da 057.
-- Sem isso, restaura a validação da 013 (papel global de quem assina pela empresa) e remove a 057.
--
-- Concorrência: a decisão é tomada SOB a trava. A tabela de capability é o único objeto cuja mudança o down
-- apagaria; o ACCESS EXCLUSIVE espera toda transação que já escreveu nela (concessão/revogação ainda aberta)
-- terminar, e bloqueia qualquer escrita nova até o COMMIT deste down. Só então a checagem lê o estado — o que
-- foi confirmado enquanto o down esperava é visto e recusa o rollback; o que chega depois não encontra a tabela.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- Existência apenas (sem decisão de segurança): dá mensagem clara em vez de "relação não existe" no LOCK.
DO $$ BEGIN
  IF to_regclass('public.empresa_membership_capacidades') IS NULL THEN
    RAISE EXCEPTION '057 down: não aplicada.';
  END IF;
END $$;

LOCK TABLE public.empresa_membership_capacidades IN ACCESS EXCLUSIVE MODE;

-- Decisão de segurança DEPOIS da trava, na mesma transação do rollback.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.empresa_membership_capacidades
              WHERE motivo <> '057: backfill — já assinava pela empresa (papel da identidade e da membership)' OR revogado_em IS NOT NULL) THEN
    RAISE EXCEPTION '057 down: há concessão ou revogação de assinatura feita por empresa depois da 057; o down perderia essa autoridade.';
  END IF;
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
   IF u.id IS NULL OR NOT u.ativo OR u.papel<>'REPRESENTANTE_AUTORIZADO' OR s.id IS NULL OR s.usuario_id<>u.id OR s.revogado_em IS NOT NULL OR s.expira_em<=clock_timestamp() OR s.ultima_atividade_em<=clock_timestamp()-interval '30 minutes' OR s.autenticado_em<clock_timestamp()-interval '5 minutes' OR NEW.autenticado_em<>s.autenticado_em OR NEW.identidade_snapshot->>'nome' IS DISTINCT FROM u.nome OR NEW.identidade_snapshot->>'cargo' IS DISTINCT FROM u.cargo THEN RAISE EXCEPTION 'Sessão/identidade de assinatura inválida' USING ERRCODE='23514'; END IF;
  ELSE
   SELECT * INTO prova FROM validacoes_identidade_cliente WHERE id=NEW.validacao_identidade_id;
   IF prova.id IS NULL OR prova.finalidade<>'CONTRATO_ACEITE' OR prova.status<>'CONSUMIDA' OR prova.consumido_por_contrato_versao_id IS DISTINCT FROM vid THEN RAISE EXCEPTION 'OTP inválido para assinatura' USING ERRCODE='23514'; END IF;
  END IF;
 END IF;
 RETURN NULL;
END $$;

DROP FUNCTION public.kidmais_057_pode_assinar_pela_empresa(uuid, uuid);
DROP TRIGGER kidmais_057_emc_imutavel_trg ON public.empresa_membership_capacidades;
DROP TABLE public.empresa_membership_capacidades;
DROP FUNCTION public.kidmais_057_emc_imutavel();

DO $$ BEGIN
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = 'public.kidmais_validar_fluxo_contrato()'::regprocedure) IS DISTINCT FROM '3de688e21a383e2dcdaf4f28bcff31d7' THEN
    RAISE EXCEPTION '057 down: a validação de contrato não voltou à da 013.';
  END IF;
END $$;

COMMIT;
