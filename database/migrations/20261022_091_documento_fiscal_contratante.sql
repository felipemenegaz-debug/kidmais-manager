-- 091 — Documento fiscal do contratante: CPF (pessoa física) além de CNPJ no teste, no cadastro público e no Fundador.
-- LOCAL, preparada em 22/10/2026 (docs/PLANO_PLANO_CPF_E_FUNDADOR.md). NÃO aplicada em staging/produção. Exige 067/068/069/074a.
-- Independente da 090. Ordem: código compatível publicado ANTES (sem a 091 o código recusa CPF com CPF_INDISPONIVEL) →
-- conferência → autorização → aplicação → postcheck → só então ASSINATURA_CPF_ATIVO=true.
-- O que muda: os CHECKs de formato aceitam também 11 dígitos; o DV é exigido só no INSERT, por gatilho (revisão de
-- 22/10/2026: um CHECK NOT VALID também valeria em todo UPDATE das linhas antigas e travaria sincronização e confirmação
-- de um documento legado com DV inválido; como o documento é imutável, conferir na inserção basta); a qualificação
-- TITULAR_PF (a própria pessoa contratante) passa a existir.
-- O que NÃO muda: documento_teste e documento_beneficiario continuam imutáveis (guardas 068/074a intactas); isenção
-- (assinatura_isencoes) continua só CNPJ; perfil_empresas.cnpj continua CNPJ; nenhuma linha é atualizada.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;

DO $$ BEGIN
  IF to_regclass('public.empresa_assinaturas') IS NULL OR to_regclass('public.assinatura_fundadores') IS NULL
     OR to_regclass('public.cadastros_empresas') IS NULL OR to_regclass('public.solicitacoes_acesso_empresa') IS NULL
     OR to_regclass('public.empresa_representacoes') IS NULL THEN
    RAISE EXCEPTION '091 exige 067, 068, 069 e 074a instaladas.';
  END IF;
  IF to_regprocedure('public.kidmais_091_documento_valido(text)') IS NOT NULL
     OR to_regprocedure('public.kidmais_091_documento_guarda()') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgname IN ('empresa_assinaturas_091_documento','assinatura_fundadores_091_documento')) THEN
    RAISE EXCEPTION '091 já aplicada total ou parcialmente.';
  END IF;
  IF (SELECT count(*) FROM pg_constraint WHERE contype = 'c' AND conname IN ('empresa_assinaturas_documento_teste_check',
        'assinatura_fundadores_documento_beneficiario_check','cadastros_empresas_documento_check','solicitacoes_documento_check',
        'empresa_representacoes_qualificacao_check')) <> 5 THEN
    RAISE EXCEPTION '091: CHECKs de documento ou qualificação divergiram da base revisada.';
  END IF;
END $$;
-- Mesma ordem dos caminhos de contratação: empresa → assinatura → concessões. ACCESS EXCLUSIVE já de início: os ALTER
-- abaixo precisam dele, e subir a trava no meio arrisca lock_timeout ou impasse com leitores.
LOCK TABLE empresa_assinaturas, assinatura_fundadores, cadastros_empresas, solicitacoes_acesso_empresa, empresa_representacoes IN ACCESS EXCLUSIVE MODE;

-- DV oficial: CPF (11 dígitos, sem sequência repetida, dois DVs módulo 11) e CNPJ numérico/alfanumérico (ASCII − 48,
-- pesos 2–9). Não consulta cadastro nem titularidade. A raiz repetida de CNPJ é política local do código (cnpj.ts).
CREATE FUNCTION kidmais_091_documento_valido(doc text) RETURNS boolean
  LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog, pg_temp AS $$
DECLARE soma integer; peso integer; d1 integer; d2 integer; i integer;
BEGIN
  IF doc ~ '^[0-9]{11}$' THEN
    IF doc ~ '^(.)\1{10}$' THEN RETURN false; END IF;
    soma := 0; FOR i IN 1..9 LOOP soma := soma + (ascii(substr(doc,i,1)) - 48) * (11 - i); END LOOP;
    d1 := (soma * 10) % 11; IF d1 = 10 THEN d1 := 0; END IF;
    soma := 0; FOR i IN 1..10 LOOP soma := soma + (ascii(substr(doc,i,1)) - 48) * (12 - i); END LOOP;
    d2 := (soma * 10) % 11; IF d2 = 10 THEN d2 := 0; END IF;
    RETURN d1 = ascii(substr(doc,10,1)) - 48 AND d2 = ascii(substr(doc,11,1)) - 48;
  END IF;
  IF doc ~ '^[0-9A-Z]{12}[0-9]{2}$' THEN
    soma := 0; peso := 2; FOR i IN REVERSE 12..1 LOOP soma := soma + (ascii(substr(doc,i,1)) - 48) * peso; peso := CASE WHEN peso = 9 THEN 2 ELSE peso + 1 END; END LOOP;
    d1 := CASE WHEN soma % 11 <= 1 THEN 0 ELSE 11 - soma % 11 END;
    soma := d1 * 2; peso := 3; FOR i IN REVERSE 12..1 LOOP soma := soma + (ascii(substr(doc,i,1)) - 48) * peso; peso := CASE WHEN peso = 9 THEN 2 ELSE peso + 1 END; END LOOP;
    d2 := CASE WHEN soma % 11 <= 1 THEN 0 ELSE 11 - soma % 11 END;
    RETURN d1 = ascii(substr(doc,13,1)) - 48 AND d2 = ascii(substr(doc,14,1)) - 48;
  END IF;
  RETURN false;
END $$;

ALTER TABLE empresa_assinaturas
  DROP CONSTRAINT empresa_assinaturas_documento_teste_check,
  ADD CONSTRAINT empresa_assinaturas_documento_teste_check CHECK (documento_teste ~ '^([0-9]{11}|[0-9A-Z]{12}[0-9]{2})$');
ALTER TABLE assinatura_fundadores
  DROP CONSTRAINT assinatura_fundadores_documento_beneficiario_check,
  ADD CONSTRAINT assinatura_fundadores_documento_beneficiario_check CHECK (documento_beneficiario ~ '^([0-9]{11}|[0-9A-Z]{12}[0-9]{2})$');

-- DV só na INSERÇÃO (documento imutável depois: guardas 068/074a). Linhas antigas continuam atualizáveis.
CREATE FUNCTION kidmais_091_documento_guarda() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE doc text;
BEGIN
  -- Ramos separados: NEW só tem o campo da própria tabela.
  IF TG_TABLE_NAME = 'empresa_assinaturas' THEN doc := NEW.documento_teste; ELSE doc := NEW.documento_beneficiario; END IF;
  IF doc IS NOT NULL AND NOT public.kidmais_091_documento_valido(doc) THEN
    RAISE EXCEPTION '091: documento com dígito verificador inválido.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER empresa_assinaturas_091_documento BEFORE INSERT ON empresa_assinaturas FOR EACH ROW EXECUTE FUNCTION kidmais_091_documento_guarda();
CREATE TRIGGER assinatura_fundadores_091_documento BEFORE INSERT ON assinatura_fundadores FOR EACH ROW EXECUTE FUNCTION kidmais_091_documento_guarda();
ALTER TABLE cadastros_empresas
  DROP CONSTRAINT cadastros_empresas_documento_check,
  ADD CONSTRAINT cadastros_empresas_documento_check CHECK (documento ~ '^([0-9]{11}|[0-9A-Z]{12}[0-9]{2})$');
ALTER TABLE solicitacoes_acesso_empresa
  DROP CONSTRAINT solicitacoes_documento_check,
  ADD CONSTRAINT solicitacoes_documento_check CHECK (documento ~ '^([0-9]{11}|[0-9A-Z]{12}[0-9]{2})$');
-- Pessoa física contrata em nome próprio: TITULAR_PF (sem sócios nem representação societária).
ALTER TABLE empresa_representacoes
  DROP CONSTRAINT empresa_representacoes_qualificacao_check,
  ADD CONSTRAINT empresa_representacoes_qualificacao_check CHECK (qualificacao IN ('SOCIO_ADMINISTRADOR','PROCURADOR','RESPONSAVEL_INDICADO','TITULAR_PF'));

COMMENT ON FUNCTION kidmais_091_documento_valido(text) IS '091: DV oficial de CPF e CNPJ (numérico e alfanumérico). Não prova titularidade.';
COMMIT;
