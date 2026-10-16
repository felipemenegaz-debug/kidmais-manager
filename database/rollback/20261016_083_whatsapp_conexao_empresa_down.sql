-- 083 rollback. Recusa se alguma conexão ou tentativa já pertence a uma empresa (não apaga histórico em uso).
-- Restaura o índice de uma conexão por ambiente e os gatilhos da 018.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = public, pg_catalog;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'whatsapp_conexoes' AND column_name = 'empresa_id') THEN
    RAISE EXCEPTION '083 rollback: 083 não aplicada.';
  END IF;
END $$;

LOCK TABLE whatsapp_conexoes, whatsapp_onboarding_tentativas IN ACCESS EXCLUSIVE MODE;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM whatsapp_conexoes WHERE empresa_id IS NOT NULL) OR EXISTS (SELECT 1 FROM whatsapp_onboarding_tentativas WHERE empresa_id IS NOT NULL) THEN
    RAISE EXCEPTION '083 rollback recusado: há conexão ou tentativa de empresa (histórico preservado).';
  END IF;
END $$;

DROP INDEX whatsapp_tentativas_empresa_ativa_uk;
DROP INDEX whatsapp_conexoes_numero_configurado_uk;
DROP INDEX whatsapp_conexoes_plataforma_configurada_uk;
DROP INDEX whatsapp_conexoes_empresa_configurada_uk;
CREATE UNIQUE INDEX whatsapp_conexoes_ambiente_configurada_uk ON whatsapp_conexoes (ambiente) WHERE status = 'CONFIGURADA';
ALTER TABLE whatsapp_onboarding_tentativas DROP CONSTRAINT whatsapp_tentativas_empresa_obrigatoria_check;
ALTER TABLE whatsapp_conexoes DROP CONSTRAINT whatsapp_conexoes_empresa_obrigatoria_check;

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

ALTER TABLE whatsapp_onboarding_tentativas DROP COLUMN empresa_id;
ALTER TABLE whatsapp_conexoes DROP COLUMN empresa_id;

COMMIT;
