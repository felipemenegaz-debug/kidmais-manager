-- PREPARADO, NÃO EXECUTADO. Volta à base anterior à 124 SÓ sem uso: recusa se houver registro de papel ou versão
-- PAPEL_CLIENTE, se algum corpo divergir do manifesto da 124 (deriva) ou se outra função depender dos objetos da 124
-- (migration posterior). Restaura literalmente os corpos da 061 (20261002_061_*.sql, linhas 268–282 e 329–390) e confere
-- os hashes da 061 antes do COMMIT. Depois do primeiro uso, o rollback operacional é desligar a rota e manter o schema.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;
LOCK TABLE public.contrato_versoes, public.contrato_assinaturas, public.contrato_assinaturas_papel IN SHARE ROW EXCLUSIVE MODE;
DO $$
DECLARE
  etapa text := 'down';
  f text[];
BEGIN
  IF EXISTS (SELECT 1 FROM public.contrato_assinaturas_papel) OR EXISTS (SELECT 1 FROM public.contrato_versoes WHERE aceite_metodo = 'PAPEL_CLIENTE') THEN
    RAISE EXCEPTION '124: rollback recusado; já há assinatura em papel do cliente registrada.';
  END IF;
  FOREACH f SLICE 1 IN ARRAY ARRAY[
      ['public.kidmais_validar_fluxo_contrato()', '7efdbe0d338b9f6a5f8320a373fbc958f5f3998fef792222bdceebfb2d1d5eb5'],
      ['public.kidmais019_formalizacao(uuid,uuid)', '6a6f9c4ae2be1563d3a097f1bdaf99332ea32cbbc417ea1145ff67d4447e8ceb'],
      ['public.kidmais124_instante_civil(date)', '82b0fff9548fc938db8da45369f85f87908eeabe2db73e57fe5ad91274473496'],
      ['public.kidmais124_validar_registro_papel()', 'd431bfcd86697f76cfb612d28f25971b60437ea17209e085e5ab143122d28afb'],
      ['public.kidmais124_imutavel()', 'f180c2d918b468f1c52ef1671f27853732ebcb2f83e0950a3c0acee3d5a632b5'],
      ['public.kidmais124_papel_cliente(uuid,uuid)', 'e2f3d094746c027aab0831d4f5c128b03535e51615c53065e3f2fef8fcd81666']] LOOP
    IF to_regprocedure(f[1]) IS NULL OR (SELECT encode(sha256(convert_to(replace(prosrc, E'\r', ''), 'UTF8')), 'hex') FROM pg_proc WHERE oid = to_regprocedure(f[1])) IS DISTINCT FROM f[2] THEN
      RAISE EXCEPTION '124 %: função % ausente ou divergente da 124', etapa, f[1];
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname NOT LIKE 'kidmais124\_%'
                AND p.proname NOT IN ('kidmais_validar_fluxo_contrato', 'kidmais019_formalizacao')
                AND (p.prosrc LIKE '%kidmais124\_%' OR p.prosrc LIKE '%contrato_assinaturas_papel%' OR p.prosrc LIKE '%PAPEL_CLIENTE%')) THEN
    RAISE EXCEPTION '124: rollback recusado; outra função depende dos objetos da 124 (migration posterior?).';
  END IF;
END $$;
DROP TRIGGER contrato_assinaturas_papel_validar_fluxo_trg ON public.contrato_assinaturas_papel;
CREATE OR REPLACE FUNCTION public.kidmais_validar_fluxo_contrato() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cid uuid; vid uuid; v contrato_versoes%ROWTYPE; e contrato_edicoes%ROWTYPE;
 f contrato_fluxos%ROWTYPE; a contrato_assinaturas%ROWTYPE; d contrato_documentos%ROWTYPE;
 s sessoes_administrativas%ROWTYPE; u usuarios_administrativos%ROWTYPE; prova validacoes_identidade_cliente%ROWTYPE;
 papel boolean := false;
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
  -- 061: contrato assinado em papel e conferido; nunca recebe assinatura digital, OTP ou comprovante.
  papel := v.aceite_metodo='CONFERENCIA_PAPEL';
  IF papel THEN
   IF v.status<>'ASSINADA' OR v.numero_versao<>1 OR e.tipo<>'INICIAL' OR e.estado<>'CONCLUIDA' OR e.documento_revisado_id IS NOT NULL
      OR EXISTS(SELECT 1 FROM contrato_assinaturas WHERE contrato_versao_id=vid)
      OR NOT EXISTS(SELECT 1 FROM contrato_importacoes ci WHERE ci.contrato_versao_id=vid AND ci.contrato_id=cid AND ci.documento_sha256=v.documento_pdf_hash)
   THEN RAISE EXCEPTION 'Conferência histórica exige vínculo com o original e nenhuma assinatura digital' USING ERRCODE='23514'; END IF;
  ELSE
  SELECT * INTO a FROM contrato_assinaturas WHERE contrato_versao_id=vid AND parte='KIDMAIS';
  IF e.estado IN ('ASSINADA_KIDMAIS','AGUARDANDO_CLIENTE','CONCLUIDA') AND (a.id IS NULL OR e.revisao_comercial_aprovada IS DISTINCT FROM e.revisao OR e.documento_revisado_id IS DISTINCT FROM a.documento_id) THEN RAISE EXCEPTION 'Assinatura Kidmais/revisão ausente' USING ERRCODE='23514'; END IF;
  IF e.estado IN ('AGUARDANDO_CLIENTE','CONCLUIDA') AND e.liberado_em IS NULL THEN RAISE EXCEPTION 'Liberação ausente' USING ERRCODE='23514'; END IF;
  IF e.estado='CONCLUIDA' AND NOT EXISTS(SELECT 1 FROM contrato_assinaturas ca WHERE ca.contrato_versao_id=vid AND ca.parte='CLIENTE' AND ca.pdf_hash=v.documento_pdf_hash AND ca.assinado_em=v.assinado_em AND ca.documento_id=a.documento_id) THEN RAISE EXCEPTION 'Aceite cliente ausente/divergente' USING ERRCODE='23514'; END IF;
  END IF;
 END IF;
 IF TG_TABLE_NAME='contrato_assinaturas' THEN
  IF papel THEN RAISE EXCEPTION 'Contrato histórico conferido não recebe assinatura digital' USING ERRCODE='23514'; END IF;
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
 AND k.pdf_hash=d.pdf_hash AND a.pdf_hash=d.pdf_hash AND v.documento_pdf_hash=d.pdf_hash)
 OR public.kidmais061_conferencia_historica(cid,vid);
$$;
DROP TABLE public.contrato_assinaturas_papel;
DROP FUNCTION public.kidmais124_papel_cliente(uuid, uuid);
DROP FUNCTION public.kidmais124_imutavel();
DROP FUNCTION public.kidmais124_validar_registro_papel();
DROP FUNCTION public.kidmais124_instante_civil(date);
ALTER TABLE public.contrato_versoes DROP CONSTRAINT contrato_versoes_aceite_metodo_check,
  ADD CONSTRAINT contrato_versoes_aceite_metodo_check CHECK (aceite_metodo IS NULL OR aceite_metodo IN ('OTP', 'CONFERENCIA_PAPEL'));
DO $$ BEGIN
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.kidmais_validar_fluxo_contrato()')) IS DISTINCT FROM '0706e34186753e34bfcb6491e947492b'
     OR (SELECT encode(sha256(convert_to(replace(prosrc, E'\r', ''), 'UTF8')), 'hex') FROM pg_proc WHERE oid = to_regprocedure('public.kidmais019_formalizacao(uuid,uuid)')) IS DISTINCT FROM '1b428128346f7158389c6a3495f72e9c92a39930b2cb4afe571b9aec900a91ba'
     OR (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.contrato_versoes'::regclass AND conname = 'contrato_versoes_aceite_metodo_check' AND convalidated)
        IS DISTINCT FROM 'CHECK (((aceite_metodo IS NULL) OR ((aceite_metodo)::text = ANY ((ARRAY[''OTP''::character varying, ''CONFERENCIA_PAPEL''::character varying])::text[]))))'
     OR EXISTS (SELECT 1 FROM pg_proc WHERE proname LIKE 'kidmais124\_%') THEN
    RAISE EXCEPTION '124 down: estado final diverge da 061';
  END IF;
END $$;
COMMIT;
