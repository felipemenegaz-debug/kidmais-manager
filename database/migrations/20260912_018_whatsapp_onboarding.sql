BEGIN;

DO $$
DECLARE
    conexao_existe boolean := to_regclass('public.whatsapp_conexoes') IS NOT NULL;
    tentativa_existe boolean := to_regclass('public.whatsapp_onboarding_tentativas') IS NOT NULL;
BEGIN
    IF conexao_existe IS DISTINCT FROM tentativa_existe THEN
        RAISE EXCEPTION 'Migration 018: instalação parcial encontrada; operação recusada.';
    END IF;
    IF to_regclass('public.usuarios_administrativos') IS NULL
       OR to_regclass('public.auditoria') IS NULL THEN
        RAISE EXCEPTION 'Migration 018: pré-requisitos administrativos ausentes.';
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.whatsapp_conexoes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    ambiente text NOT NULL,
    meta_app_id text NOT NULL,
    business_id text NOT NULL,
    waba_id text NOT NULL,
    phone_number_id text NOT NULL,
    numero_exibicao text NOT NULL,
    nome_verificado text NOT NULL,
    coexistencia_confirmada boolean NOT NULL,
    status text NOT NULL DEFAULT 'CONFIGURADA',
    escopos text[] NOT NULL,
    credencial_cifrada bytea NOT NULL,
    credencial_iv bytea NOT NULL,
    credencial_tag bytea NOT NULL,
    credencial_chave_versao integer NOT NULL,
    token_tipo text NOT NULL,
    token_expira_em timestamptz,
    meta_validada_em timestamptz NOT NULL,
    criada_por_usuario_id uuid NOT NULL REFERENCES public.usuarios_administrativos(id),
    sessao_referencia_id uuid NOT NULL,
    criada_em timestamptz NOT NULL DEFAULT clock_timestamp(),
    atualizada_em timestamptz NOT NULL DEFAULT clock_timestamp(),
    desconectada_em timestamptz,
    desconectada_por_usuario_id uuid REFERENCES public.usuarios_administrativos(id),
    motivo_desconexao text,
    revisao integer NOT NULL DEFAULT 1,
    CONSTRAINT whatsapp_conexoes_ambiente_check CHECK (ambiente IN ('STAGING', 'PRODUCTION')),
    CONSTRAINT whatsapp_conexoes_meta_app_id_check CHECK (meta_app_id ~ '^[0-9]+$'),
    CONSTRAINT whatsapp_conexoes_business_id_check CHECK (business_id ~ '^[0-9]+$'),
    CONSTRAINT whatsapp_conexoes_waba_id_check CHECK (waba_id ~ '^[0-9]+$'),
    CONSTRAINT whatsapp_conexoes_phone_number_id_check CHECK (phone_number_id ~ '^[0-9]+$'),
    CONSTRAINT whatsapp_conexoes_numero_exibicao_check CHECK (length(btrim(numero_exibicao)) BETWEEN 3 AND 40),
    CONSTRAINT whatsapp_conexoes_nome_verificado_check CHECK (length(btrim(nome_verificado)) BETWEEN 1 AND 255),
    CONSTRAINT whatsapp_conexoes_status_check CHECK (status IN ('CONFIGURADA', 'DESCONECTADA')),
    CONSTRAINT whatsapp_conexoes_coexistencia_check CHECK (status <> 'CONFIGURADA' OR coexistencia_confirmada),
    CONSTRAINT whatsapp_conexoes_escopos_check CHECK (cardinality(escopos) > 0),
    CONSTRAINT whatsapp_conexoes_credencial_check CHECK (
        octet_length(credencial_cifrada) > 0
        AND octet_length(credencial_iv) = 12
        AND octet_length(credencial_tag) = 16
        AND credencial_chave_versao > 0
    ),
    CONSTRAINT whatsapp_conexoes_token_tipo_check CHECK (length(btrim(token_tipo)) BETWEEN 1 AND 80),
    CONSTRAINT whatsapp_conexoes_revisao_check CHECK (revisao > 0),
    CONSTRAINT whatsapp_conexoes_datas_check CHECK (
        atualizada_em >= criada_em
        AND meta_validada_em >= criada_em
        AND (token_expira_em IS NULL OR token_expira_em > meta_validada_em)
    ),
    CONSTRAINT whatsapp_conexoes_desconexao_check CHECK (
        (status = 'CONFIGURADA' AND desconectada_em IS NULL AND desconectada_por_usuario_id IS NULL AND motivo_desconexao IS NULL)
        OR
        (status = 'DESCONECTADA' AND desconectada_em IS NOT NULL AND desconectada_por_usuario_id IS NOT NULL AND length(btrim(motivo_desconexao)) >= 3)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_conexoes_ambiente_configurada_uk
    ON public.whatsapp_conexoes (ambiente)
    WHERE status = 'CONFIGURADA';

CREATE TABLE IF NOT EXISTS public.whatsapp_onboarding_tentativas (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    ambiente text NOT NULL,
    usuario_id uuid NOT NULL REFERENCES public.usuarios_administrativos(id),
    sessao_referencia_id uuid NOT NULL,
    state_hash bytea NOT NULL,
    status text NOT NULL DEFAULT 'INICIADA',
    expira_em timestamptz NOT NULL,
    consumida_em timestamptz,
    business_id text,
    waba_id text,
    phone_number_id text,
    conexao_id uuid REFERENCES public.whatsapp_conexoes(id),
    erro_codigo text,
    criada_em timestamptz NOT NULL DEFAULT clock_timestamp(),
    atualizada_em timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT whatsapp_tentativas_ambiente_check CHECK (ambiente IN ('STAGING', 'PRODUCTION')),
    CONSTRAINT whatsapp_tentativas_state_hash_check CHECK (octet_length(state_hash) = 32),
    CONSTRAINT whatsapp_tentativas_status_check CHECK (status IN ('INICIADA', 'VALIDANDO', 'CONCLUIDA', 'EXPIRADA', 'RECUSADA', 'FALHOU')),
    CONSTRAINT whatsapp_tentativas_business_id_check CHECK (business_id IS NULL OR business_id ~ '^[0-9]+$'),
    CONSTRAINT whatsapp_tentativas_waba_id_check CHECK (waba_id IS NULL OR waba_id ~ '^[0-9]+$'),
    CONSTRAINT whatsapp_tentativas_phone_number_id_check CHECK (phone_number_id IS NULL OR phone_number_id ~ '^[0-9]+$'),
    CONSTRAINT whatsapp_tentativas_erro_codigo_check CHECK (erro_codigo IS NULL OR erro_codigo ~ '^[A-Z0-9_]{3,80}$'),
    CONSTRAINT whatsapp_tentativas_validade_check CHECK (expira_em > criada_em AND expira_em <= criada_em + interval '15 minutes'),
    CONSTRAINT whatsapp_tentativas_atualizacao_check CHECK (atualizada_em >= criada_em),
    CONSTRAINT whatsapp_tentativas_estado_check CHECK (
        (status = 'INICIADA' AND consumida_em IS NULL AND conexao_id IS NULL AND business_id IS NULL AND waba_id IS NULL AND phone_number_id IS NULL AND erro_codigo IS NULL)
        OR
        (status = 'VALIDANDO' AND consumida_em IS NOT NULL AND conexao_id IS NULL AND business_id IS NULL AND waba_id IS NULL AND phone_number_id IS NULL AND erro_codigo IS NULL)
        OR
        (status = 'CONCLUIDA' AND consumida_em IS NOT NULL AND conexao_id IS NOT NULL AND business_id IS NOT NULL AND waba_id IS NOT NULL AND phone_number_id IS NOT NULL AND erro_codigo IS NULL)
        OR
        (status IN ('EXPIRADA', 'RECUSADA', 'FALHOU') AND consumida_em IS NOT NULL AND conexao_id IS NULL AND erro_codigo IS NOT NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_tentativas_state_hash_uk
    ON public.whatsapp_onboarding_tentativas (state_hash);
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_tentativas_usuario_iniciada_uk
    ON public.whatsapp_onboarding_tentativas (ambiente, usuario_id)
    WHERE status IN ('INICIADA', 'VALIDANDO');
CREATE INDEX IF NOT EXISTS whatsapp_tentativas_expiracao_idx
    ON public.whatsapp_onboarding_tentativas (status, expira_em);

CREATE OR REPLACE FUNCTION public.kidmais_whatsapp_conexao_proteger()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Conexão WhatsApp deve permanecer no histórico' USING ERRCODE = '23514';
    END IF;
    IF OLD.status = 'DESCONECTADA' AND NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION 'Conexão WhatsApp desconectada é imutável' USING ERRCODE = '23514';
    END IF;
    IF ROW(NEW.ambiente, NEW.meta_app_id, NEW.business_id, NEW.waba_id, NEW.phone_number_id,
           NEW.criada_por_usuario_id, NEW.sessao_referencia_id, NEW.criada_em)
       IS DISTINCT FROM
       ROW(OLD.ambiente, OLD.meta_app_id, OLD.business_id, OLD.waba_id, OLD.phone_number_id,
           OLD.criada_por_usuario_id, OLD.sessao_referencia_id, OLD.criada_em) THEN
        RAISE EXCEPTION 'Identidade da conexão WhatsApp é imutável' USING ERRCODE = '23514';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status AND NOT (OLD.status = 'CONFIGURADA' AND NEW.status = 'DESCONECTADA') THEN
        RAISE EXCEPTION 'Transição da conexão WhatsApp recusada' USING ERRCODE = '23514';
    END IF;
    IF NEW.revisao <> OLD.revisao + 1 OR NEW.atualizada_em <= OLD.atualizada_em THEN
        RAISE EXCEPTION 'Revisão da conexão WhatsApp inválida' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.kidmais_whatsapp_tentativa_proteger()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Tentativa de onboarding deve permanecer no histórico' USING ERRCODE = '23514';
    END IF;
    IF OLD.status NOT IN ('INICIADA', 'VALIDANDO') THEN
        RAISE EXCEPTION 'Tentativa de onboarding já consumida é imutável' USING ERRCODE = '23514';
    END IF;
    IF ROW(NEW.id, NEW.ambiente, NEW.usuario_id, NEW.sessao_referencia_id, NEW.state_hash, NEW.expira_em, NEW.criada_em)
       IS DISTINCT FROM
       ROW(OLD.id, OLD.ambiente, OLD.usuario_id, OLD.sessao_referencia_id, OLD.state_hash, OLD.expira_em, OLD.criada_em) THEN
        RAISE EXCEPTION 'Identidade da tentativa de onboarding é imutável' USING ERRCODE = '23514';
    END IF;
    IF NEW.status = OLD.status OR NEW.consumida_em IS NULL OR NEW.atualizada_em <= OLD.atualizada_em
       OR (OLD.status = 'INICIADA' AND NEW.status NOT IN ('VALIDANDO', 'EXPIRADA', 'RECUSADA', 'FALHOU'))
       OR (OLD.status = 'VALIDANDO' AND NEW.status NOT IN ('CONCLUIDA', 'EXPIRADA', 'RECUSADA', 'FALHOU')) THEN
        RAISE EXCEPTION 'Consumo da tentativa de onboarding inválido' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'whatsapp_conexoes_proteger_trg' AND tgrelid = 'public.whatsapp_conexoes'::regclass) THEN
        CREATE TRIGGER whatsapp_conexoes_proteger_trg
        BEFORE UPDATE OR DELETE ON public.whatsapp_conexoes
        FOR EACH ROW EXECUTE FUNCTION public.kidmais_whatsapp_conexao_proteger();
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'whatsapp_tentativas_proteger_trg' AND tgrelid = 'public.whatsapp_onboarding_tentativas'::regclass) THEN
        CREATE TRIGGER whatsapp_tentativas_proteger_trg
        BEFORE UPDATE OR DELETE ON public.whatsapp_onboarding_tentativas
        FOR EACH ROW EXECUTE FUNCTION public.kidmais_whatsapp_tentativa_proteger();
    END IF;
END $$;

COMMIT;
