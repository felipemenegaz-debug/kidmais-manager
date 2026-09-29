BEGIN;

-- 057 — Assinatura de contrato em nome da empresa é autoridade EMPRESARIAL (decisão de produto, Gate 12).
--
--   tenant → membership ATIVA → papel atual (Gestão) → capability CONTRATO_ASSINAR_EMPRESA → contrato da empresa.
--   1. empresa_membership_capacidades: capability empresarial por membership (empresa + membership, FK composta),
--      mesmo modelo da 056 (concede/revoga uma vez; nada é apagado).
--   2. kidmais_057_pode_assinar_pela_empresa(usuário, versão): a regra acima, com a empresa do contrato
--      (fechamento e pacote da mesma empresa, empresa ATIVA).
--   3. kidmais_validar_fluxo_contrato (013): o corpo é o da 013 com UMA troca — a exigência do papel GLOBAL
--      REPRESENTANTE_AUTORIZADO de quem assina pela empresa passa a ser a regra 2. O papel global fica só para
--      a plataforma. A 013 não é alterada; o precheck confere que a função atual é exatamente a da 013.
--   4. Backfill determinístico: recebe a capability exatamente quem já podia assinar por aquela empresa —
--      membership ATIVA com papel REPRESENTANTE_AUTORIZADO de identidade ativa com papel global
--      REPRESENTANTE_AUTORIZADO. Ninguém ganha nem perde assinatura na aplicação da migration.
--
-- Assinaturas e contratos históricos não são tocados: a validação só roda para assinatura NOVA (AFTER INSERT).

SET LOCAL lock_timeout = '5s';

DO $$ BEGIN
  IF to_regclass('public.festa_membership_capacidades') IS NULL
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'memberships' AND column_name = 'papel') THEN
    RAISE EXCEPTION '057: exige a 056 (papel e capacidade por membership).';
  END IF;
  IF to_regclass('public.empresa_membership_capacidades') IS NOT NULL
     OR to_regprocedure('public.kidmais_057_pode_assinar_pela_empresa(uuid,uuid)') IS NOT NULL THEN
    RAISE EXCEPTION '057: já aplicada.';
  END IF;
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = 'public.kidmais_validar_fluxo_contrato()'::regprocedure) IS DISTINCT FROM '3de688e21a383e2dcdaf4f28bcff31d7' THEN
    RAISE EXCEPTION '057: kidmais_validar_fluxo_contrato difere da 013; revise antes de aplicar.';
  END IF;
END $$;

LOCK TABLE public.memberships, public.usuarios_administrativos IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE public.empresa_membership_capacidades (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  capacidade text NOT NULL,
  concedido_por uuid NOT NULL REFERENCES public.usuarios_administrativos (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  concedido_em timestamptz NOT NULL DEFAULT now(),
  motivo text NOT NULL,
  revogado_por uuid REFERENCES public.usuarios_administrativos (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  revogado_em timestamptz,
  motivo_revogacao text,
  CONSTRAINT kidmais_057_emc_membership_fk FOREIGN KEY (empresa_id, membership_id)
    REFERENCES public.memberships (empresa_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT kidmais_057_emc_capacidade_ck CHECK (capacidade IN ('CONTRATO_ASSINAR_EMPRESA')),
  CONSTRAINT kidmais_057_emc_motivo_ck CHECK (length(btrim(motivo)) >= 3),
  CONSTRAINT kidmais_057_emc_revogacao_ck CHECK (
    (revogado_por IS NULL AND revogado_em IS NULL AND motivo_revogacao IS NULL)
    OR (revogado_por IS NOT NULL AND revogado_em IS NOT NULL AND length(btrim(motivo_revogacao)) >= 3)
  )
);
CREATE UNIQUE INDEX kidmais_057_emc_ativa_uk ON public.empresa_membership_capacidades (membership_id, capacidade) WHERE revogado_em IS NULL;
CREATE INDEX kidmais_057_emc_empresa_idx ON public.empresa_membership_capacidades (empresa_id, membership_id);

CREATE FUNCTION public.kidmais_057_emc_imutavel()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '057: capacidade da empresa não é apagada; revogue.';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.empresa_id IS DISTINCT FROM OLD.empresa_id
     OR NEW.membership_id IS DISTINCT FROM OLD.membership_id OR NEW.capacidade IS DISTINCT FROM OLD.capacidade
     OR NEW.concedido_por IS DISTINCT FROM OLD.concedido_por OR NEW.concedido_em IS DISTINCT FROM OLD.concedido_em
     OR NEW.motivo IS DISTINCT FROM OLD.motivo OR OLD.revogado_em IS NOT NULL THEN
    RAISE EXCEPTION '057: capacidade da empresa só pode ser revogada, uma vez.';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER kidmais_057_emc_imutavel_trg
BEFORE UPDATE OR DELETE ON public.empresa_membership_capacidades
FOR EACH ROW EXECUTE FUNCTION public.kidmais_057_emc_imutavel();

CREATE FUNCTION public.kidmais_057_pode_assinar_pela_empresa(p_usuario uuid, p_versao uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.contrato_versoes ver
      JOIN public.contratos c ON c.id = ver.contrato_id
      JOIN public.fechamentos fe ON fe.id = c.fechamento_id AND fe.empresa_id IS NOT NULL
      JOIN public.pacotes pac ON pac.id = fe.pacote_id AND pac.empresa_id = fe.empresa_id
      JOIN public.empresas emp ON emp.id = fe.empresa_id AND emp.status = 'ATIVA'
      JOIN public.memberships m ON m.empresa_id = fe.empresa_id AND m.usuario_id = p_usuario
                               AND m.status = 'ATIVA' AND m.papel = 'REPRESENTANTE_AUTORIZADO'
      JOIN public.empresa_membership_capacidades cap ON cap.membership_id = m.id AND cap.empresa_id = m.empresa_id
                               AND cap.capacidade = 'CONTRATO_ASSINAR_EMPRESA' AND cap.revogado_em IS NULL
     WHERE ver.id = p_versao
  );
$$;

INSERT INTO public.empresa_membership_capacidades (empresa_id, membership_id, capacidade, concedido_por, motivo)
SELECT m.empresa_id, m.id, 'CONTRATO_ASSINAR_EMPRESA', m.usuario_id, '057: backfill — já assinava pela empresa (papel da identidade e da membership)'
  FROM public.memberships m
  JOIN public.usuarios_administrativos u ON u.id = m.usuario_id
 WHERE m.status = 'ATIVA' AND m.papel = 'REPRESENTANTE_AUTORIZADO'
   AND u.ativo AND u.papel = 'REPRESENTANTE_AUTORIZADO';

-- Corpo da 013 com a única troca descrita em 3 (gerado a partir do arquivo da 013).
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

DO $$ BEGIN
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = 'public.kidmais_validar_fluxo_contrato()'::regprocedure) IS DISTINCT FROM 'e7d4d19ac1b1d925135adbc45a2247a5' THEN
    RAISE EXCEPTION '057: corpo da validação de contrato não confere.';
  END IF;
END $$;

COMMIT;
