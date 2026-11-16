-- 124 — Contrato assinado pelo cliente em papel (PAPEL_CLIENTE). Plano r3 + r3.1 (vault: "Contrato assinado em papel e
-- botao de pacotes 20261114"), classe A.
--
-- NÃO APLICADA. Exige autorização explícita de Felipe (docs/OPERACAO_AGENTES.md) para qualquer banco, inclusive staging.
-- Ordem da cadeia: 123 → 122 → 124 (a 119 continua reservada). Pré e pós: database/checks/20261115_124_*.sql.
-- Down: database/rollback/20261115_124_assinatura_papel_cliente_down.sql (recusa com dados; restaura os corpos da 061).
--
-- O que muda:
--   * nova tabela imutável `contrato_assinaturas_papel`: uma linha por versão, registrada pela Gestão da empresa, com a
--     data civil em que o cliente assinou o papel e, opcionalmente, a cópia digitalizada (PDF/JPEG/PNG até 25 MB);
--   * `contrato_versoes.aceite_metodo` passa a aceitar 'PAPEL_CLIENTE'. A exigência de template (061) NÃO muda: a versão
--     assinada em papel pelo cliente grava o template do documento revisado, como a assinatura por OTP;
--   * `kidmais_validar_fluxo_contrato` (corpo da 061) ganha UM ramo, sem retorno antecipado. Vale no COMMIT, inclusive
--     para SQL direto: V1 inicial nativa, assinada pelo buffet, liberada, documento/hash/template coerentes, data entre a
--     liberação e o registro (America/Sao_Paulo), assinado_em = meio-dia SP da data, e nunca junto de assinatura CLIENTE;
--   * `kidmais019_formalizacao` (corpo da 061) aceita também `kidmais124_papel_cliente`. Nada mais muda nela.
-- O OTP dos demais fluxos e a conferência histórica da 061 ficam idênticos.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;

DO $$ BEGIN
  IF to_regclass('public.contrato_assinaturas_papel') IS NOT NULL
     OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname LIKE 'kidmais124\_%') THEN
    RAISE EXCEPTION '124 já aplicada (ou parcialmente presente).';
  END IF;
  IF to_regclass('public.contrato_importacoes') IS NULL THEN RAISE EXCEPTION '124 exige a 061.'; END IF;
  IF to_regclass('public.oportunidades_acoes') IS NULL THEN RAISE EXCEPTION '124 exige a 122 (oportunidades).'; END IF;
  IF to_regclass('public.festa_pessoas') IS NULL THEN RAISE EXCEPTION '124 exige a 123 (área da família).'; END IF;
  -- Os corpos substituídos precisam ser exatamente os instalados pela 061.
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = 'public.kidmais_validar_fluxo_contrato()'::regprocedure) IS DISTINCT FROM '0706e34186753e34bfcb6491e947492b' THEN
    RAISE EXCEPTION '124: validação de contrato diverge da 061.';
  END IF;
  IF (SELECT encode(sha256(convert_to(replace(prosrc, E'\r', ''), 'UTF8')), 'hex') FROM pg_proc WHERE oid = 'public.kidmais019_formalizacao(uuid,uuid)'::regprocedure) IS DISTINCT FROM '1b428128346f7158389c6a3495f72e9c92a39930b2cb4afe571b9aec900a91ba' THEN
    RAISE EXCEPTION '124: formalização diverge da 061.';
  END IF;
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='public.contrato_versoes'::regclass AND conname='contrato_versoes_aceite_metodo_check')
     IS DISTINCT FROM 'CHECK (((aceite_metodo IS NULL) OR ((aceite_metodo)::text = ANY ((ARRAY[''OTP''::character varying, ''CONFERENCIA_PAPEL''::character varying])::text[]))))' THEN
    RAISE EXCEPTION '124: CHECK de método de aceite diverge da 061.';
  END IF;
END $$;

-- 1. Método novo. A CHECK de template (061) continua a mesma: PAPEL_CLIENTE exige template, como o OTP.
ALTER TABLE public.contrato_versoes DROP CONSTRAINT contrato_versoes_aceite_metodo_check,
  ADD CONSTRAINT contrato_versoes_aceite_metodo_check CHECK (aceite_metodo IS NULL OR aceite_metodo IN ('OTP', 'CONFERENCIA_PAPEL', 'PAPEL_CLIENTE'));

-- 2. Registro da assinatura do cliente em papel. Imutável; uma linha por versão.
CREATE TABLE public.contrato_assinaturas_papel (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES public.empresas(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  contrato_id uuid NOT NULL REFERENCES public.contratos(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  contrato_versao_id uuid NOT NULL,
  -- Data civil (America/Sao_Paulo) em que o cliente assinou o papel, declarada pela Gestão.
  data_declarada date NOT NULL,
  -- Instante real do registro: clock_timestamp() gravado UMA vez no BEFORE INSERT (o valor enviado é ignorado).
  registrado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  registrado_por_usuario_id uuid NOT NULL REFERENCES public.usuarios_administrativos(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  membership_id uuid NOT NULL REFERENCES public.memberships(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  observacao text CHECK (observacao IS NULL OR (char_length(observacao) BETWEEN 1 AND 500 AND btrim(observacao) <> '')),
  arquivo bytea,
  arquivo_tipo varchar(32),
  arquivo_tamanho integer,
  arquivo_sha256 char(64),
  chave_idempotencia uuid NOT NULL,
  payload_hash char(64) NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT contrato_assinaturas_papel_versao_uk UNIQUE (contrato_versao_id),
  CONSTRAINT contrato_assinaturas_papel_chave_uk UNIQUE (empresa_id, chave_idempotencia),
  CONSTRAINT contrato_assinaturas_papel_versao_fk FOREIGN KEY (contrato_id, contrato_versao_id)
    REFERENCES public.contrato_versoes(contrato_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT contrato_assinaturas_papel_arquivo_completo_ck CHECK (num_nonnulls(arquivo, arquivo_tipo, arquivo_tamanho, arquivo_sha256) IN (0, 4)),
  CONSTRAINT contrato_assinaturas_papel_arquivo_tipo_ck CHECK (arquivo_tipo IN ('application/pdf', 'image/jpeg', 'image/png')),
  CONSTRAINT contrato_assinaturas_papel_arquivo_tamanho_ck CHECK (arquivo_tamanho BETWEEN 1 AND 26214400 AND octet_length(arquivo) = arquivo_tamanho),
  CONSTRAINT contrato_assinaturas_papel_arquivo_sha_ck CHECK (arquivo_sha256 ~ '^[0-9a-f]{64}$')
);
CREATE INDEX contrato_assinaturas_papel_contrato_idx ON public.contrato_assinaturas_papel (contrato_id);
CREATE INDEX contrato_assinaturas_papel_empresa_idx ON public.contrato_assinaturas_papel (empresa_id, registrado_em DESC);

COMMENT ON TABLE public.contrato_assinaturas_papel IS
'124: assinatura do cliente em papel registrada pela Gestão (data declarada + cópia opcional). Imutável. Não é assinatura digital nem OTP.';

-- Instante convencional da data civil: meio-dia em São Paulo (nenhum fuso do Brasil muda o dia). Não é hora factual.
CREATE FUNCTION public.kidmais124_instante_civil(d date) RETURNS timestamptz
LANGUAGE sql STABLE SET search_path = public, pg_catalog AS $$
 SELECT (d + time '12:00') AT TIME ZONE 'America/Sao_Paulo';
$$;

-- Conferido só no registro: quem registra, em qual empresa, o arquivo e o teto da data. A membership NÃO é revalidada
-- depois (o registro histórico continua válido se a pessoa sair da empresa).
CREATE FUNCTION public.kidmais124_validar_registro_papel() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
DECLARE empresa_contrato uuid;
BEGIN
 NEW.registrado_em := clock_timestamp();
 SELECT fe.empresa_id INTO empresa_contrato FROM contratos c JOIN fechamentos fe ON fe.id=c.fechamento_id WHERE c.id=NEW.contrato_id;
 IF empresa_contrato IS NULL OR empresa_contrato<>NEW.empresa_id THEN
  RAISE EXCEPTION '124: contrato não pertence à empresa do registro' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT 1 FROM memberships m JOIN usuarios_administrativos u ON u.id=m.usuario_id
   WHERE m.id=NEW.membership_id AND m.empresa_id=NEW.empresa_id AND m.usuario_id=NEW.registrado_por_usuario_id
     AND m.status='ATIVA' AND m.revogado_em IS NULL AND (m.vigente_ate IS NULL OR m.vigente_ate>clock_timestamp())
     AND m.papel='REPRESENTANTE_AUTORIZADO' AND u.ativo) THEN
  RAISE EXCEPTION '124: registro exige a Gestão ativa da empresa' USING ERRCODE='23514'; END IF;
 IF NEW.arquivo IS NOT NULL AND encode(sha256(NEW.arquivo), 'hex') IS DISTINCT FROM NEW.arquivo_sha256 THEN
  RAISE EXCEPTION '124: sha256 do arquivo divergente' USING ERRCODE='23514'; END IF;
 IF NEW.data_declarada > (NEW.registrado_em AT TIME ZONE 'America/Sao_Paulo')::date THEN
  RAISE EXCEPTION '124: data declarada no futuro' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER contrato_assinaturas_papel_validar_registro_trg BEFORE INSERT ON public.contrato_assinaturas_papel
  FOR EACH ROW EXECUTE FUNCTION public.kidmais124_validar_registro_papel();

CREATE FUNCTION public.kidmais124_imutavel() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
BEGIN RAISE EXCEPTION '124: assinatura em papel registrada é imutável' USING ERRCODE='23514'; END $$;
CREATE TRIGGER contrato_assinaturas_papel_imutavel_trg BEFORE UPDATE OR DELETE ON public.contrato_assinaturas_papel
  FOR EACH ROW EXECUTE FUNCTION public.kidmais124_imutavel();
CREATE TRIGGER contrato_assinaturas_papel_truncate_trg BEFORE TRUNCATE ON public.contrato_assinaturas_papel
  FOR EACH STATEMENT EXECUTE FUNCTION public.kidmais124_imutavel();

-- 3. Formalização pelo papel do cliente: o EXISTS da 019/061 com a linha de papel no lugar da assinatura CLIENTE.
CREATE FUNCTION public.kidmais124_papel_cliente(cid uuid,vid uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = public, pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM contratos c JOIN contrato_fluxos cf ON cf.contrato_id=c.id
 JOIN fechamentos fe ON fe.id=c.fechamento_id
 JOIN contrato_versoes v ON v.id=cf.versao_vigente_id
 JOIN contrato_edicoes e ON e.contrato_versao_id=v.id
 JOIN contrato_documentos d ON d.id=e.documento_revisado_id
 JOIN contrato_assinaturas k ON k.contrato_versao_id=v.id AND k.parte='KIDMAIS'
 JOIN contrato_assinaturas_papel p ON p.contrato_versao_id=v.id AND p.contrato_id=c.id AND p.empresa_id=fe.empresa_id
 WHERE c.id=cid AND v.id=vid AND c.status='ASSINADO' AND c.cancelado_em IS NULL
 AND v.status='ASSINADA' AND e.estado='CONCLUIDA' AND v.aceite_metodo='PAPEL_CLIENTE'
 AND k.documento_id=d.id AND d.contrato_versao_id=v.id
 AND k.snapshot_hash=v.snapshot_hash AND d.snapshot_hash=v.snapshot_hash
 AND k.pdf_hash=d.pdf_hash AND v.documento_pdf_hash=d.pdf_hash
 AND NOT EXISTS(SELECT 1 FROM contrato_assinaturas a WHERE a.contrato_versao_id=v.id AND a.parte='CLIENTE'));
$$;

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
 OR public.kidmais061_conferencia_historica(cid,vid)
 OR public.kidmais124_papel_cliente(cid,vid);
$$;

-- 4. Validação de fluxo da 061 com UM ramo explícito para a assinatura do cliente em papel. O restante é o corpo da 061.
CREATE OR REPLACE FUNCTION public.kidmais_validar_fluxo_contrato() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cid uuid; vid uuid; v contrato_versoes%ROWTYPE; e contrato_edicoes%ROWTYPE;
 f contrato_fluxos%ROWTYPE; a contrato_assinaturas%ROWTYPE; d contrato_documentos%ROWTYPE;
 s sessoes_administrativas%ROWTYPE; u usuarios_administrativos%ROWTYPE; prova validacoes_identidade_cliente%ROWTYPE;
 papel boolean := false; papel_cliente boolean := false; pc contrato_assinaturas_papel%ROWTYPE; dr contrato_documentos%ROWTYPE;
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
  -- 124: o método OU a linha de papel ligam o ramo (trocar um sem o outro cai aqui e é recusado).
  SELECT * INTO pc FROM contrato_assinaturas_papel WHERE contrato_versao_id=vid;
  papel_cliente := v.aceite_metodo='PAPEL_CLIENTE' OR pc.id IS NOT NULL;
  IF papel THEN
   IF v.status<>'ASSINADA' OR v.numero_versao<>1 OR e.tipo<>'INICIAL' OR e.estado<>'CONCLUIDA' OR e.documento_revisado_id IS NOT NULL
      OR EXISTS(SELECT 1 FROM contrato_assinaturas WHERE contrato_versao_id=vid)
      OR NOT EXISTS(SELECT 1 FROM contrato_importacoes ci WHERE ci.contrato_versao_id=vid AND ci.contrato_id=cid AND ci.documento_sha256=v.documento_pdf_hash)
   THEN RAISE EXCEPTION 'Conferência histórica exige vínculo com o original e nenhuma assinatura digital' USING ERRCODE='23514'; END IF;
   IF pc.id IS NOT NULL THEN RAISE EXCEPTION 'Conferência histórica não recebe assinatura do cliente em papel' USING ERRCODE='23514'; END IF;
  ELSIF papel_cliente THEN
   -- 124: V1 inicial nativa, assinada pelo buffet e liberada; o papel substitui SÓ o aceite CLIENTE por OTP.
   SELECT * INTO a FROM contrato_assinaturas WHERE contrato_versao_id=vid AND parte='KIDMAIS';
   SELECT * INTO dr FROM contrato_documentos WHERE id=e.documento_revisado_id;
   IF v.aceite_metodo IS DISTINCT FROM 'PAPEL_CLIENTE' OR pc.id IS NULL OR pc.contrato_id<>cid
      OR pc.empresa_id IS DISTINCT FROM (SELECT fe.empresa_id FROM contratos c JOIN fechamentos fe ON fe.id=c.fechamento_id WHERE c.id=cid)
      OR v.numero_versao<>1 OR e.tipo<>'INICIAL' OR e.origem_versao_id IS NOT NULL OR e.dados_fonte ? 'revisaoInicial'
      OR EXISTS(SELECT 1 FROM contrato_importacoes ci WHERE ci.contrato_versao_id=vid OR ci.contrato_id=cid)
      OR EXISTS(SELECT 1 FROM fechamento_revisoes r WHERE r.contrato_versao_id=vid OR r.versao_base_id=vid)
      OR v.status<>'ASSINADA' OR e.estado<>'CONCLUIDA'
   THEN RAISE EXCEPTION 'Assinatura do cliente em papel exige a V1 inicial nativa concluída com o registro' USING ERRCODE='23514'; END IF;
   IF a.id IS NULL OR e.revisao_comercial_aprovada IS DISTINCT FROM e.revisao OR e.documento_revisado_id IS DISTINCT FROM a.documento_id
      OR dr.id IS NULL OR dr.snapshot_hash IS DISTINCT FROM v.snapshot_hash OR dr.pdf_hash IS DISTINCT FROM v.documento_pdf_hash OR a.pdf_hash IS DISTINCT FROM dr.pdf_hash
      OR v.documento_template_versao IS NULL OR v.documento_template_versao IS DISTINCT FROM dr.template_versao
   THEN RAISE EXCEPTION 'Assinatura do cliente em papel exige o documento assinado pelo buffet' USING ERRCODE='23514'; END IF;
   IF e.liberado_em IS NULL OR pc.data_declarada < (e.liberado_em AT TIME ZONE 'America/Sao_Paulo')::date
      OR pc.data_declarada > (pc.registrado_em AT TIME ZONE 'America/Sao_Paulo')::date
      OR v.assinado_em IS DISTINCT FROM public.kidmais124_instante_civil(pc.data_declarada)
   THEN RAISE EXCEPTION 'Data da assinatura em papel fora da liberação e do registro' USING ERRCODE='23514'; END IF;
   IF EXISTS(SELECT 1 FROM contrato_assinaturas ca WHERE ca.contrato_versao_id=vid AND ca.parte='CLIENTE') THEN RAISE EXCEPTION 'Contrato com assinatura em papel não recebe assinatura digital' USING ERRCODE='23514'; END IF;
  ELSE
  SELECT * INTO a FROM contrato_assinaturas WHERE contrato_versao_id=vid AND parte='KIDMAIS';
  IF e.estado IN ('ASSINADA_KIDMAIS','AGUARDANDO_CLIENTE','CONCLUIDA') AND (a.id IS NULL OR e.revisao_comercial_aprovada IS DISTINCT FROM e.revisao OR e.documento_revisado_id IS DISTINCT FROM a.documento_id) THEN RAISE EXCEPTION 'Assinatura Kidmais/revisão ausente' USING ERRCODE='23514'; END IF;
  IF e.estado IN ('AGUARDANDO_CLIENTE','CONCLUIDA') AND e.liberado_em IS NULL THEN RAISE EXCEPTION 'Liberação ausente' USING ERRCODE='23514'; END IF;
  IF e.estado='CONCLUIDA' AND NOT EXISTS(SELECT 1 FROM contrato_assinaturas ca WHERE ca.contrato_versao_id=vid AND ca.parte='CLIENTE' AND ca.pdf_hash=v.documento_pdf_hash AND ca.assinado_em=v.assinado_em AND ca.documento_id=a.documento_id) THEN RAISE EXCEPTION 'Aceite cliente ausente/divergente' USING ERRCODE='23514'; END IF;
  END IF;
 END IF;
 IF TG_TABLE_NAME='contrato_assinaturas' THEN
  IF papel THEN RAISE EXCEPTION 'Contrato histórico conferido não recebe assinatura digital' USING ERRCODE='23514'; END IF;
  IF papel_cliente THEN RAISE EXCEPTION 'Contrato com assinatura em papel não recebe assinatura digital' USING ERRCODE='23514'; END IF;
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

-- Mesmo gatilho diferido das tabelas do fluxo (013:233–236): a linha de papel também é conferida no COMMIT.
CREATE CONSTRAINT TRIGGER contrato_assinaturas_papel_validar_fluxo_trg AFTER INSERT ON public.contrato_assinaturas_papel
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.kidmais_validar_fluxo_contrato();

COMMIT;
