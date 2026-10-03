-- 061 — Integração de contratos históricos importados ao Core (fechamento, contrato, festa, agenda e financeiro).
--
-- NÃO APLICADA. Exige autorização explícita (docs/OPERACAO_AGENTES.md) para qualquer banco, inclusive staging e clones.
-- Sem esta migration o código continua funcionando: a integração responde "indisponível neste ambiente" e os
-- contratos importados permanecem na projeção somente leitura da etapa 1.
--
-- Regra explícita para UMA origem nova, `IMPORTACAO_HISTORICA`. O fluxo nativo (assinatura KIDMAIS com sessão
-- reautenticada + aceite CLIENTE por OTP) não é enfraquecido:
--   * contrato assinado em papel entra como versão ASSINADA com `aceite_metodo = 'CONFERENCIA_PAPEL'`, documento =
--     sha256 do ORIGINAL importado e conferência registrada por operador autorizado da empresa em
--     `contrato_importacoes`. Nenhuma assinatura digital, OTP ou comprovante é criado; versão de conferência que
--     receber assinatura digital é recusada. Versões posteriores do mesmo contrato seguem o fluxo nativo (OTP).
--   * `kidmais019_formalizacao` aceita a conferência em papel só com todos os vínculos acima; nada mais muda nela.
--   * ocupação: a reserva do contrato histórico é vigente como qualquer outra (`kidmais019_ocupa` não muda). Só a
--     DETECÇÃO DE CONFLITO ignora o evento histórico que já tinha acontecido na data da integração, e só enquanto ele
--     estiver exatamente no slot integrado (data, início, fim). Qualquer remarcação tira a isenção: o novo slot ocupa a
--     agenda e passa pelas validações (hold da revisão, conflito, bloqueio) como no fluxo nativo.
--   * pagamentos, parcelas e recebimentos continuam nas tabelas e serviços nativos; `contrato_importacao_financeiro`
--     só registra a conferência humana (sem totais paralelos). Sem essa linha, o financeiro fica pendente de conferência.
-- Sem backfill: nada é integrado automaticamente. Vínculos, conferências e festas nascem só pelo serviço de domínio
-- (lib/contratos/integracao-importados), depois da confirmação humana.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = public, pg_catalog;

DO $$ BEGIN
  IF to_regclass('public.contrato_importacoes') IS NOT NULL THEN RAISE EXCEPTION '061 já aplicada.'; END IF;
  IF to_regclass('public.ia_importacoes') IS NULL OR to_regclass('public.ia_documento_originais') IS NULL THEN
    RAISE EXCEPTION '061 exige 055c/055d (ia_importacoes e ia_documento_originais).';
  END IF;
  IF to_regclass('public.estabelecimentos') IS NULL OR to_regclass('public.empresa_membership_capacidades') IS NULL THEN
    RAISE EXCEPTION '061 exige 043 e 057.';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='fechamentos' AND column_name='empresa_id') THEN
    RAISE EXCEPTION '061 exige 054 (fechamentos.empresa_id).';
  END IF;
  -- Os corpos substituídos precisam ser exatamente os instalados por 019 e 057.
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = 'public.kidmais_validar_fluxo_contrato()'::regprocedure) IS DISTINCT FROM 'e7d4d19ac1b1d925135adbc45a2247a5' THEN
    RAISE EXCEPTION '061: validação de contrato diverge da 057.';
  END IF;
  IF (SELECT encode(sha256(convert_to(replace(prosrc, E'\r', ''), 'UTF8')), 'hex') FROM pg_proc WHERE oid = 'public.kidmais019_formalizacao(uuid,uuid)'::regprocedure) IS DISTINCT FROM 'ef21416cd23e5a2d59c486abc83470ca47dc30a2ef8501b488d216c88804fa25'
     OR (SELECT encode(sha256(convert_to(replace(prosrc, E'\r', ''), 'UTF8')), 'hex') FROM pg_proc WHERE oid = 'public.kidmais_ocupacoes_operacionais(date,date)'::regprocedure) IS DISTINCT FROM '2257c1df5a299a86d60a59b8606e432715dd10d713e4659f370934dcf483be91'
     OR (SELECT encode(sha256(convert_to(replace(prosrc, E'\r', ''), 'UTF8')), 'hex') FROM pg_proc WHERE oid = 'public.kidmais_validar_agenda_revisao()'::regprocedure) IS DISTINCT FROM '997158485f6dc9595cf6045594b220206c59c31b631bc164aad3956963875e89' THEN
    RAISE EXCEPTION '061: formalização/agenda divergem da 019.';
  END IF;
  IF EXISTS(SELECT 1 FROM public.fechamentos WHERE origem_fechamento = 'IMPORTACAO_HISTORICA')
     OR EXISTS(SELECT 1 FROM public.contrato_versoes WHERE aceite_metodo IS DISTINCT FROM 'OTP' AND aceite_metodo IS NOT NULL) THEN
    RAISE EXCEPTION '061: origem histórica já presente sem a migration.';
  END IF;
END $$;

-- 1. Valores novos, restritos à origem histórica (o vínculo é exigido pelos gatilhos abaixo).
ALTER TABLE public.fechamentos DROP CONSTRAINT fechamentos_origem_check,
  ADD CONSTRAINT fechamentos_origem_check CHECK (origem_fechamento IN ('CLIENTE', 'ATENDIMENTO_KIDMAIS', 'IMPORTACAO_HISTORICA'));
ALTER TABLE public.contrato_versoes DROP CONSTRAINT contrato_versoes_aceite_metodo_check,
  ADD CONSTRAINT contrato_versoes_aceite_metodo_check CHECK (aceite_metodo IS NULL OR aceite_metodo IN ('OTP', 'CONFERENCIA_PAPEL')),
  DROP CONSTRAINT contrato_versoes_assinatura_documento_check,
  ADD CONSTRAINT contrato_versoes_assinatura_documento_check CHECK (
    status <> 'ASSINADA' OR (documento_pdf_hash IS NOT NULL AND aceite_metodo IS NOT NULL
      AND (documento_template_versao IS NOT NULL OR aceite_metodo = 'CONFERENCIA_PAPEL')));
ALTER TABLE public.festas DROP CONSTRAINT festa019_autoria_check,
  ADD CONSTRAINT festa019_autoria_check CHECK (
    (origem_criacao IN ('MANUAL_HISTORICA', 'IMPORTACAO_HISTORICA') AND criado_por IS NOT NULL) OR
    (origem_criacao = 'AUTOMATICA_FORMALIZACAO' AND criado_por IS NULL));

-- 2. Vínculo importação → Core com a conferência histórica do contrato em papel. Imutável.
CREATE TABLE public.contrato_importacoes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES public.empresas(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  importacao_id uuid NOT NULL REFERENCES public.ia_importacoes(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  estabelecimento_id uuid,
  cliente_id uuid NOT NULL REFERENCES public.clientes(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  fechamento_id uuid NOT NULL REFERENCES public.fechamentos(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  contrato_id uuid NOT NULL REFERENCES public.contratos(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  contrato_versao_id uuid NOT NULL,
  documento_original_id uuid NOT NULL REFERENCES public.ia_documento_originais(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  documento_sha256 char(64) NOT NULL CHECK (documento_sha256 ~ '^[0-9a-f]{64}$'),
  situacao_contrato varchar(16) NOT NULL CHECK (situacao_contrato = 'VIGENTE'),
  financeiro_declarado varchar(16) NOT NULL CHECK (financeiro_declarado IN ('CONFERIDO', 'NAO_CONFERIDO')),
  -- Data (America/Sao_Paulo) da integração: evento anterior a ela é histórico e não ocupa agenda. Definida no banco.
  agenda_a_partir_de date NOT NULL,
  -- Slot do fechamento no momento da integração (copiado pelo banco). A isenção de conflito vale só para este slot.
  data_evento date NOT NULL,
  horario_inicio time NOT NULL,
  horario_fim time NOT NULL,
  decisoes jsonb NOT NULL CHECK (jsonb_typeof(decisoes) = 'object'),
  declaracao text NOT NULL CHECK (length(btrim(declaracao)) BETWEEN 20 AND 1000),
  chave_idempotencia uuid NOT NULL UNIQUE,
  payload_hash char(64) NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  conferido_por uuid NOT NULL REFERENCES public.usuarios_administrativos(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  conferido_papel varchar(32) NOT NULL CHECK (conferido_papel IN ('ADMINISTRATIVO', 'REPRESENTANTE_AUTORIZADO')),
  conferido_em timestamptz NOT NULL,
  request_id uuid NOT NULL,
  CONSTRAINT contrato_importacoes_importacao_uk UNIQUE (importacao_id),
  CONSTRAINT contrato_importacoes_fechamento_uk UNIQUE (fechamento_id),
  CONSTRAINT contrato_importacoes_contrato_uk UNIQUE (contrato_id),
  CONSTRAINT contrato_importacoes_versao_uk UNIQUE (contrato_versao_id),
  CONSTRAINT contrato_importacoes_empresa_id_uk UNIQUE (empresa_id, id),
  CONSTRAINT contrato_importacoes_versao_fk FOREIGN KEY (contrato_id, contrato_versao_id)
    REFERENCES public.contrato_versoes(contrato_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT contrato_importacoes_estabelecimento_fk FOREIGN KEY (empresa_id, estabelecimento_id)
    REFERENCES public.estabelecimentos(empresa_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX contrato_importacoes_empresa_idx ON public.contrato_importacoes (empresa_id, conferido_em DESC);

-- 3. Conferência humana dos pagamentos do contrato histórico. Os valores vivem no Core (pagamentos/parcelas/recebimentos);
--    aqui ficam só a decisão, os totais conferidos em centavos e a idempotência. Uma por integração; imutável.
CREATE TABLE public.contrato_importacao_financeiro (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL,
  contrato_importacao_id uuid NOT NULL,
  pagamento_id uuid NOT NULL REFERENCES public.pagamentos(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  situacao varchar(20) NOT NULL CHECK (situacao IN ('NAO_PAGO', 'PARCIALMENTE_PAGO', 'PAGO')),
  contratado_centavos bigint NOT NULL CHECK (contratado_centavos > 0),
  recebido_centavos bigint NOT NULL CHECK (recebido_centavos >= 0),
  saldo_centavos bigint NOT NULL CHECK (saldo_centavos >= 0),
  decisoes jsonb NOT NULL CHECK (jsonb_typeof(decisoes) = 'object'),
  chave_idempotencia uuid NOT NULL UNIQUE,
  payload_hash char(64) NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  conferido_por uuid NOT NULL REFERENCES public.usuarios_administrativos(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  conferido_papel varchar(32) NOT NULL CHECK (conferido_papel IN ('ADMINISTRATIVO', 'REPRESENTANTE_AUTORIZADO')),
  conferido_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  request_id uuid NOT NULL,
  CONSTRAINT contrato_importacao_financeiro_integracao_uk UNIQUE (contrato_importacao_id),
  CONSTRAINT contrato_importacao_financeiro_pagamento_uk UNIQUE (pagamento_id),
  CONSTRAINT contrato_importacao_financeiro_integracao_fk FOREIGN KEY (empresa_id, contrato_importacao_id)
    REFERENCES public.contrato_importacoes(empresa_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT contrato_importacao_financeiro_soma_ck CHECK (recebido_centavos + saldo_centavos = contratado_centavos),
  CONSTRAINT contrato_importacao_financeiro_situacao_ck CHECK (
    (situacao = 'NAO_PAGO' AND recebido_centavos = 0) OR (situacao = 'PAGO' AND saldo_centavos = 0)
    OR (situacao = 'PARCIALMENTE_PAGO' AND recebido_centavos > 0 AND saldo_centavos > 0))
);

CREATE FUNCTION public.kidmais061_imutavel() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
BEGIN
 RAISE EXCEPTION '061: registro de integração histórica é imutável' USING ERRCODE='23514';
END $$;
CREATE TRIGGER contrato_importacoes_imutavel_trg BEFORE UPDATE OR DELETE ON public.contrato_importacoes
  FOR EACH ROW EXECUTE FUNCTION public.kidmais061_imutavel();
CREATE TRIGGER contrato_importacao_financeiro_imutavel_trg BEFORE UPDATE OR DELETE ON public.contrato_importacao_financeiro
  FOR EACH ROW EXECUTE FUNCTION public.kidmais061_imutavel();
CREATE TRIGGER contrato_importacoes_truncate_trg BEFORE TRUNCATE ON public.contrato_importacoes
  FOR EACH STATEMENT EXECUTE FUNCTION public.kidmais061_imutavel();
CREATE TRIGGER contrato_importacao_financeiro_truncate_trg BEFORE TRUNCATE ON public.contrato_importacao_financeiro
  FOR EACH STATEMENT EXECUTE FUNCTION public.kidmais061_imutavel();

-- O vínculo só nasce coerente: importação confirmada da mesma empresa, original da mesma importação, fechamento da
-- origem histórica, contrato desse fechamento, versão de conferência em papel com o hash do original e operador
-- com membership ativa da empresa no papel registrado. Data da agenda e instante vêm do banco.
CREATE FUNCTION public.kidmais061_validar_vinculo() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
DECLARE i ia_importacoes%ROWTYPE; o ia_documento_originais%ROWTYPE; f fechamentos%ROWTYPE; c contratos%ROWTYPE; v contrato_versoes%ROWTYPE;
BEGIN
 SELECT * INTO i FROM ia_importacoes WHERE id=NEW.importacao_id FOR SHARE;
 IF i.id IS NULL OR i.empresa_id<>NEW.empresa_id OR i.status<>'IMPORTADA' OR i.cliente_id IS DISTINCT FROM NEW.cliente_id THEN
  RAISE EXCEPTION '061: importação inexistente, de outra empresa ou não confirmada' USING ERRCODE='23514'; END IF;
 SELECT * INTO o FROM ia_documento_originais WHERE id=NEW.documento_original_id;
 IF o.id IS NULL OR o.empresa_id<>NEW.empresa_id OR o.documento_id<>i.documento_id OR o.sha256<>NEW.documento_sha256 THEN
  RAISE EXCEPTION '061: documento original não pertence à importação' USING ERRCODE='23514'; END IF;
 SELECT * INTO f FROM fechamentos WHERE id=NEW.fechamento_id;
 IF f.id IS NULL OR f.empresa_id IS DISTINCT FROM NEW.empresa_id OR f.origem_fechamento<>'IMPORTACAO_HISTORICA' OR f.cliente_id IS DISTINCT FROM NEW.cliente_id THEN
  RAISE EXCEPTION '061: fechamento não é da origem histórica desta empresa e cliente' USING ERRCODE='23514'; END IF;
 SELECT * INTO c FROM contratos WHERE id=NEW.contrato_id;
 SELECT * INTO v FROM contrato_versoes WHERE id=NEW.contrato_versao_id;
 IF c.id IS NULL OR c.fechamento_id<>NEW.fechamento_id OR v.contrato_id<>c.id OR v.numero_versao<>1
    OR v.aceite_metodo IS DISTINCT FROM 'CONFERENCIA_PAPEL' OR v.documento_pdf_hash IS DISTINCT FROM NEW.documento_sha256 THEN
  RAISE EXCEPTION '061: contrato/versão de conferência incoerentes' USING ERRCODE='23514'; END IF;
 -- Unidade: a FK composta garante que é da mesma empresa. Elegibilidade para agenda NÃO é decidida aqui: a integração
 -- só fica disponível com a 062, cujo gatilho exige unidade elegível na contratação e a mesma unidade no vínculo.
 IF NOT EXISTS(SELECT 1 FROM memberships m JOIN usuarios_administrativos u ON u.id=m.usuario_id
   WHERE m.empresa_id=NEW.empresa_id AND m.usuario_id=NEW.conferido_por AND m.status='ATIVA' AND m.papel=NEW.conferido_papel AND u.ativo) THEN
  RAISE EXCEPTION '061: conferência exige operador ativo da empresa' USING ERRCODE='23514'; END IF;
 NEW.conferido_em := clock_timestamp();
 NEW.agenda_a_partir_de := (clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date;
 NEW.data_evento := f.data_evento; NEW.horario_inicio := f.horario_inicio; NEW.horario_fim := f.horario_fim;
 RETURN NEW;
END $$;
CREATE TRIGGER contrato_importacoes_validar_trg BEFORE INSERT ON public.contrato_importacoes
  FOR EACH ROW EXECUTE FUNCTION public.kidmais061_validar_vinculo();

CREATE FUNCTION public.kidmais061_validar_financeiro() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
DECLARE ci contrato_importacoes%ROWTYPE;
BEGIN
 SELECT * INTO ci FROM contrato_importacoes WHERE id=NEW.contrato_importacao_id AND empresa_id=NEW.empresa_id;
 IF ci.id IS NULL THEN RAISE EXCEPTION '061: integração inexistente nesta empresa' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pagamentos p WHERE p.id=NEW.pagamento_id AND p.contrato_versao_id=ci.contrato_versao_id
   AND round(p.valor_total_contratado*100)::bigint=NEW.contratado_centavos) THEN
  RAISE EXCEPTION '061: pagamento não é a obrigação do contrato histórico' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT 1 FROM memberships m JOIN usuarios_administrativos u ON u.id=m.usuario_id
   WHERE m.empresa_id=NEW.empresa_id AND m.usuario_id=NEW.conferido_por AND m.status='ATIVA' AND m.papel=NEW.conferido_papel AND u.ativo) THEN
  RAISE EXCEPTION '061: conferência exige operador ativo da empresa' USING ERRCODE='23514'; END IF;
 NEW.conferido_em := clock_timestamp();
 RETURN NEW;
END $$;
CREATE TRIGGER contrato_importacao_financeiro_validar_trg BEFORE INSERT ON public.contrato_importacao_financeiro
  FOR EACH ROW EXECUTE FUNCTION public.kidmais061_validar_financeiro();

-- Fechamento da origem histórica só existe com o vínculo (verificado no commit) e a origem nunca muda.
CREATE FUNCTION public.kidmais061_origem_fechamento() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
BEGIN
 IF TG_OP='UPDATE' AND NEW.origem_fechamento IS DISTINCT FROM OLD.origem_fechamento
    AND 'IMPORTACAO_HISTORICA' IN (NEW.origem_fechamento, OLD.origem_fechamento) THEN
  RAISE EXCEPTION '061: origem histórica do fechamento é imutável' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER fechamentos_061_origem_trg BEFORE UPDATE OF origem_fechamento ON public.fechamentos
  FOR EACH ROW EXECUTE FUNCTION public.kidmais061_origem_fechamento();

CREATE FUNCTION public.kidmais061_exigir_vinculo() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
DECLARE ci contrato_importacoes%ROWTYPE;
BEGIN
 IF TG_TABLE_NAME='fechamentos' THEN
  IF NEW.origem_fechamento='IMPORTACAO_HISTORICA' AND NOT EXISTS(SELECT 1 FROM contrato_importacoes WHERE fechamento_id=NEW.id) THEN
   RAISE EXCEPTION '061: fechamento histórico exige vínculo com a importação' USING ERRCODE='23514'; END IF;
 ELSIF TG_TABLE_NAME='contrato_importacoes' THEN
  -- Declarado CONFERIDO na integração ⇒ a conferência financeira nasce na mesma transação.
  IF NEW.financeiro_declarado='CONFERIDO' AND NOT EXISTS(SELECT 1 FROM contrato_importacao_financeiro WHERE contrato_importacao_id=NEW.id) THEN
   RAISE EXCEPTION '061: pagamentos declarados conferidos sem registro financeiro' USING ERRCODE='23514'; END IF;
 ELSIF TG_TABLE_NAME='festas' THEN
  SELECT * INTO ci FROM contrato_importacoes WHERE contrato_id=NEW.contrato_id;
  IF (NEW.origem_criacao='IMPORTACAO_HISTORICA') <> (ci.id IS NOT NULL AND NEW.versao_contratual_criacao_id=ci.contrato_versao_id) THEN
   RAISE EXCEPTION '061: Festa de importação histórica só nasce da conferência do contrato importado' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER fechamentos_061_vinculo_trg AFTER INSERT ON public.fechamentos
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.kidmais061_exigir_vinculo();
CREATE CONSTRAINT TRIGGER contrato_importacoes_061_financeiro_trg AFTER INSERT ON public.contrato_importacoes
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.kidmais061_exigir_vinculo();
-- Prefixo festa019_: gatilhos posteriores à 016 ficam fora do contrato físico congelado da 016 (lib/festas/estrutura-016.ts).
CREATE CONSTRAINT TRIGGER festa019_061_origem_importacao AFTER INSERT ON public.festas
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.kidmais061_exigir_vinculo();

-- 4. Conferência histórica: só com vínculo, hash do original e SEM assinatura digital.
CREATE FUNCTION public.kidmais061_conferencia_historica(cid uuid,vid uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = public, pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM contratos c JOIN contrato_fluxos cf ON cf.contrato_id=c.id
 JOIN contrato_versoes v ON v.id=cf.versao_vigente_id
 JOIN contrato_edicoes e ON e.contrato_versao_id=v.id
 JOIN contrato_importacoes ci ON ci.contrato_versao_id=v.id AND ci.contrato_id=c.id AND ci.fechamento_id=c.fechamento_id
 WHERE c.id=cid AND v.id=vid AND c.status='ASSINADO' AND c.cancelado_em IS NULL
 AND v.status='ASSINADA' AND e.estado='CONCLUIDA' AND e.tipo='INICIAL' AND e.documento_revisado_id IS NULL
 AND v.aceite_metodo='CONFERENCIA_PAPEL' AND v.documento_pdf_hash=ci.documento_sha256
 AND NOT EXISTS(SELECT 1 FROM contrato_assinaturas a WHERE a.contrato_versao_id=v.id));
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
 OR public.kidmais061_conferencia_historica(cid,vid);
$$;

-- Evento histórico já realizado na data da integração, ainda no slot integrado: não entra na detecção de conflito.
CREATE FUNCTION public.kidmais061_historico_passado(fid uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = public, pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM contrato_importacoes ci JOIN fechamentos f ON f.id=ci.fechamento_id
 WHERE f.id=fid AND ci.data_evento<ci.agenda_a_partir_de
 AND f.data_evento=ci.data_evento AND f.horario_inicio=ci.horario_inicio AND f.horario_fim=ci.horario_fim);
$$;

-- Corpos da 019 com UMA condição a mais cada (isenção acima). A reserva (kidmais019_ocupa), o hold da revisão e o
-- conflito de qualquer outro slot seguem idênticos.
CREATE OR REPLACE FUNCTION public.kidmais_ocupacoes_operacionais(inicio date,fim date)
RETURNS TABLE(fechamento_id uuid,revisao_id uuid,origem text,data date,horario_inicio time,horario_fim time)
LANGUAGE sql STABLE AS $$
 SELECT f.id,NULL::uuid,'CONFIRMADA'::text,f.data_evento,f.horario_inicio,f.horario_fim
 FROM public.fechamentos f WHERE public.kidmais019_ocupa(f.id) AND NOT public.kidmais061_historico_passado(f.id) AND f.data_evento BETWEEN inicio AND fim
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
  IF NOT public.kidmais019_ocupa(f.id) OR public.kidmais061_historico_passado(f.id) THEN RETURN NULL; END IF;
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

-- 5. Validação de fluxo da 057 com UM ramo explícito para a versão de conferência em papel. O restante é o corpo da 057.
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

COMMENT ON TABLE public.contrato_importacoes IS
'061: vínculo imutável importação → fechamento/contrato/versão, com a conferência histórica do contrato assinado em papel. Não é assinatura digital.';
COMMENT ON TABLE public.contrato_importacao_financeiro IS
'061: conferência humana dos pagamentos do contrato histórico. Valores ficam em pagamentos/parcelas/recebimentos (sem totais paralelos).';

COMMIT;
