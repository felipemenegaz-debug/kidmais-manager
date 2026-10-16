-- 083 — WhatsApp por empresa: cada empresa (tenant) conecta o próprio número pelo Embedded Signup da Meta.
--
-- NÃO APLICADA. Exige autorização explícita (docs/OPERACAO_AGENTES.md) para qualquer banco, inclusive staging e clones.
--
-- Até a 018 a conexão era UMA por ambiente (índice único em `ambiente`) e só a plataforma conectava. A partir daqui:
--   - `whatsapp_conexoes.empresa_id` e `whatsapp_onboarding_tentativas.empresa_id` (FK empresas);
--   - uma conexão CONFIGURADA por (ambiente, empresa) e o mesmo número (phone_number_id) em no máximo uma conexão
--     CONFIGURADA por ambiente;
--   - conexão CONFIGURADA nova e tentativa em andamento nova EXIGEM empresa (CHECK NOT VALID: linhas antigas, da
--     plataforma e sem empresa, continuam válidas, inertes e no histórico; nenhuma linha existente é alterada);
--   - `empresa_id` entra na identidade imutável das duas tabelas (gatilhos da 018 recriados com a coluna).
-- Aditiva: o código anterior continua consultando; só uma conexão nova SEM empresa passa a ser recusada.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = public, pg_catalog;

DO $$ BEGIN
  IF to_regclass('public.whatsapp_conexoes') IS NULL OR to_regclass('public.whatsapp_onboarding_tentativas') IS NULL THEN
    RAISE EXCEPTION '083 exige a 018 (whatsapp_conexoes e whatsapp_onboarding_tentativas).';
  END IF;
  IF to_regclass('public.empresas') IS NULL THEN RAISE EXCEPTION '083 exige a 031 (empresas).'; END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'whatsapp_conexoes' AND column_name = 'empresa_id') THEN
    RAISE EXCEPTION '083 já aplicada.';
  END IF;
  IF to_regclass('public.whatsapp_conexoes_ambiente_configurada_uk') IS NULL THEN
    RAISE EXCEPTION '083: índice whatsapp_conexoes_ambiente_configurada_uk (018) ausente; estado divergente.';
  END IF;
END $$;

LOCK TABLE whatsapp_conexoes, whatsapp_onboarding_tentativas IN SHARE ROW EXCLUSIVE MODE;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM whatsapp_conexoes WHERE status = 'CONFIGURADA' GROUP BY ambiente, phone_number_id HAVING count(*) > 1) THEN
    RAISE EXCEPTION '083: número com mais de uma conexão CONFIGURADA no mesmo ambiente; revise antes de aplicar.';
  END IF;
END $$;

ALTER TABLE whatsapp_conexoes ADD COLUMN empresa_id uuid REFERENCES empresas (id);
ALTER TABLE whatsapp_onboarding_tentativas ADD COLUMN empresa_id uuid REFERENCES empresas (id);

ALTER TABLE whatsapp_conexoes ADD CONSTRAINT whatsapp_conexoes_empresa_obrigatoria_check
  CHECK (status <> 'CONFIGURADA' OR empresa_id IS NOT NULL) NOT VALID;
ALTER TABLE whatsapp_onboarding_tentativas ADD CONSTRAINT whatsapp_tentativas_empresa_obrigatoria_check
  CHECK (empresa_id IS NOT NULL OR status IN ('CONCLUIDA', 'EXPIRADA', 'RECUSADA', 'FALHOU')) NOT VALID;

DROP INDEX whatsapp_conexoes_ambiente_configurada_uk;
CREATE UNIQUE INDEX whatsapp_conexoes_empresa_configurada_uk
  ON whatsapp_conexoes (ambiente, empresa_id) WHERE status = 'CONFIGURADA' AND empresa_id IS NOT NULL;
-- Conexão antiga da plataforma (sem empresa): continua no máximo uma por ambiente, como na 018.
CREATE UNIQUE INDEX whatsapp_conexoes_plataforma_configurada_uk
  ON whatsapp_conexoes (ambiente) WHERE status = 'CONFIGURADA' AND empresa_id IS NULL;
CREATE UNIQUE INDEX whatsapp_conexoes_numero_configurado_uk
  ON whatsapp_conexoes (ambiente, phone_number_id) WHERE status = 'CONFIGURADA';
CREATE UNIQUE INDEX whatsapp_tentativas_empresa_ativa_uk
  ON whatsapp_onboarding_tentativas (ambiente, empresa_id) WHERE status IN ('INICIADA', 'VALIDANDO') AND empresa_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.kidmais_whatsapp_conexao_proteger()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Conexão WhatsApp deve permanecer no histórico' USING ERRCODE = '23514';
    END IF;
    IF OLD.status = 'DESCONECTADA' AND NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION 'Conexão WhatsApp desconectada é imutável' USING ERRCODE = '23514';
    END IF;
    IF ROW(NEW.ambiente, NEW.empresa_id, NEW.meta_app_id, NEW.business_id, NEW.waba_id, NEW.phone_number_id,
           NEW.criada_por_usuario_id, NEW.sessao_referencia_id, NEW.criada_em)
       IS DISTINCT FROM
       ROW(OLD.ambiente, OLD.empresa_id, OLD.meta_app_id, OLD.business_id, OLD.waba_id, OLD.phone_number_id,
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
    IF ROW(NEW.id, NEW.ambiente, NEW.empresa_id, NEW.usuario_id, NEW.sessao_referencia_id, NEW.state_hash, NEW.expira_em, NEW.criada_em)
       IS DISTINCT FROM
       ROW(OLD.id, OLD.ambiente, OLD.empresa_id, OLD.usuario_id, OLD.sessao_referencia_id, OLD.state_hash, OLD.expira_em, OLD.criada_em) THEN
        RAISE EXCEPTION 'Identidade da tentativa de onboarding é imutável' USING ERRCODE = '23514';
    END IF;
    IF NEW.status = OLD.status OR NEW.consumida_em IS NULL OR NEW.atualizada_em <= OLD.atualizada_em
       OR (OLD.status = 'INICIADA' AND NEW.status NOT IN ('VALIDANDO', 'EXPIRADA', 'RECUSADA', 'FALHOU'))
       OR (OLD.status = 'VALIDANDO' AND NEW.status NOT IN ('CONCLUIDA', 'EXPIRADA', 'RECUSADA', 'FALHOU')) THEN
        RAISE EXCEPTION 'Consumo da tentativa de onboarding inválido' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;

COMMIT;
