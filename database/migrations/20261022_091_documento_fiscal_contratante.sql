-- 091 — Documento fiscal do contratante: CPF (pessoa física) além de CNPJ no teste, no cadastro público e no Fundador.
-- LOCAL, preparada em 22/10/2026 (docs/PLANO_PLANO_CPF_E_FUNDADOR.md). NÃO aplicada em staging/produção. Exige 067/068/069/074a.
-- Independente da 090. Ordem: código compatível publicado ANTES (sem a 091 o código recusa CPF com CPF_INDISPONIVEL) →
-- conferência → autorização → aplicação → postcheck → só então ASSINATURA_CPF_ATIVO=true.
-- O que muda: os CHECKs de formato aceitam também 11 dígitos; o DV é exigido só no INSERT, por gatilho (revisão de
-- 22/10/2026: um CHECK NOT VALID também valeria em todo UPDATE das linhas antigas e travaria sincronização e confirmação
-- de um documento legado com DV inválido; como o documento é imutável, conferir na inserção basta); a qualificação
-- TITULAR_PF (a própria pessoa contratante) passa a existir.
-- Continuidade assistida (D5, parecer jurídico de apoio de 22/10/2026): empresa_documento_continuidades registra, pelo
-- atendimento, a retificação de documento ou a formalização CPF → CNPJ da mesma operação, com instrumento, evidências,
-- data efetiva e retrato das condições. Os snapshots NÃO são reescritos: o documento vigente passa a ser o da última
-- continuidade; preço, ciclo, benefício e datas originais seguem os registros existentes.
-- O que NÃO muda: documento_teste e documento_beneficiario continuam imutáveis (guardas 068/074a intactas); isenção
-- (assinatura_isencoes) continua só CNPJ; perfil_empresas.cnpj continua CNPJ; nenhuma linha é atualizada.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;

DO $$ BEGIN
  IF to_regclass('public.empresa_assinaturas') IS NULL OR to_regclass('public.assinatura_fundadores') IS NULL
     OR to_regclass('public.cadastros_empresas') IS NULL OR to_regclass('public.solicitacoes_acesso_empresa') IS NULL
     OR to_regclass('public.empresa_representacoes') IS NULL OR to_regclass('public.usuarios_administrativos') IS NULL THEN
    RAISE EXCEPTION '091 exige 067, 068, 069 e 074a instaladas.';
  END IF;
  IF to_regprocedure('public.kidmais_091_documento_valido(text)') IS NOT NULL
     OR to_regprocedure('public.kidmais_091_documento_guarda()') IS NOT NULL
     OR to_regclass('public.empresa_documento_continuidades') IS NOT NULL OR to_regprocedure('public.kidmais_091_continuidade_guarda()') IS NOT NULL
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

-- Continuidade assistida (D5). Uma linha por retificação/formalização; nunca apagada. Só o atendimento (painel do
-- desenvolvedor) registra. Nasce PENDENTE_PROVEDOR; CONCLUIDA só depois da conferência do provedor registrada. RETIFICACAO: mesmo tipo de documento (erro de digitação). MESMA_TITULARIDADE
-- (empresário individual/MEI) e CESSAO (sociedade, cessão de posição contratual): sempre CPF → CNPJ.
CREATE TABLE empresa_documento_continuidades (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresas(id),
  tipo text NOT NULL CHECK (tipo IN ('RETIFICACAO','MESMA_TITULARIDADE','CESSAO')),
  documento_anterior text NOT NULL CHECK (documento_anterior ~ '^([0-9]{11}|[0-9A-Z]{12}[0-9]{2})$'),
  documento_novo text NOT NULL CHECK (documento_novo ~ '^([0-9]{11}|[0-9A-Z]{12}[0-9]{2})$'),
  nome_novo text NOT NULL CHECK (length(btrim(nome_novo)) BETWEEN 2 AND 200),
  instrumento text NOT NULL CHECK (length(btrim(instrumento)) BETWEEN 5 AND 300),
  evidencias text NOT NULL CHECK (length(btrim(evidencias)) BETWEEN 5 AND 1000),
  data_efetiva date NOT NULL,
  condicoes jsonb NOT NULL CHECK (jsonb_typeof(condicoes) = 'object'),
  situacao text NOT NULL CHECK (situacao IN ('PENDENTE_PROVEDOR','CONCLUIDA')),
  provedor_conferido_em timestamptz,
  provedor_conferido_por uuid REFERENCES usuarios_administrativos(id),
  provedor_nota text CHECK (provedor_nota IS NULL OR length(btrim(provedor_nota)) BETWEEN 5 AND 500),
  registrada_por uuid NOT NULL REFERENCES usuarios_administrativos(id),
  registrada_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT empresa_doc_continuidades_documentos_check CHECK (documento_novo <> documento_anterior
    AND (tipo = 'RETIFICACAO') = (length(documento_novo) = length(documento_anterior))
    AND (tipo = 'RETIFICACAO' OR (length(documento_anterior) = 11 AND length(documento_novo) = 14))),
  CONSTRAINT empresa_doc_continuidades_conferencia_check CHECK ((situacao = 'CONCLUIDA')
    = (provedor_conferido_em IS NOT NULL AND provedor_conferido_por IS NOT NULL AND provedor_nota IS NOT NULL))
);
CREATE UNIQUE INDEX empresa_doc_continuidades_documento_uk ON empresa_documento_continuidades (documento_novo);
CREATE UNIQUE INDEX empresa_doc_continuidades_pendente_uk ON empresa_documento_continuidades (empresa_id) WHERE situacao = 'PENDENTE_PROVEDOR';
CREATE INDEX empresa_doc_continuidades_empresa_idx ON empresa_documento_continuidades (empresa_id, registrada_em DESC);

-- Inserção: DV do documento novo e encadeamento (o anterior é o vigente: última continuidade ou o documento do teste,
-- lido com a linha da assinatura travada). Atualização: só PENDENTE_PROVEDOR → CONCLUIDA, com a conferência. Sem DELETE.
CREATE FUNCTION kidmais_091_continuidade_guarda() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE vigente text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '091: continuidade de documento não é apagada.' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.situacao <> 'PENDENTE_PROVEDOR' OR NEW.situacao <> 'CONCLUIDA'
       OR (NEW.id, NEW.empresa_id, NEW.tipo, NEW.documento_anterior, NEW.documento_novo, NEW.nome_novo, NEW.instrumento, NEW.evidencias,
           NEW.data_efetiva, NEW.condicoes, NEW.registrada_por, NEW.registrada_em)
          IS DISTINCT FROM (OLD.id, OLD.empresa_id, OLD.tipo, OLD.documento_anterior, OLD.documento_novo, OLD.nome_novo, OLD.instrumento,
           OLD.evidencias, OLD.data_efetiva, OLD.condicoes, OLD.registrada_por, OLD.registrada_em) THEN
      RAISE EXCEPTION '091: continuidade só passa de PENDENTE_PROVEDOR para CONCLUIDA; o registro é imutável.' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT public.kidmais_091_documento_valido(NEW.documento_novo) THEN
    RAISE EXCEPTION '091: documento com dígito verificador inválido.' USING ERRCODE = '23514';
  END IF;
  -- Aplicação imediata: a data efetiva não pode estar no futuro (calendário de Brasília).
  IF NEW.data_efetiva > (clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date THEN
    RAISE EXCEPTION '091: data efetiva futura; a continuidade vale a partir do registro.' USING ERRCODE = 'P0001';
  END IF;
  SELECT a.documento_teste INTO vigente FROM public.empresa_assinaturas a WHERE a.empresa_id = NEW.empresa_id FOR UPDATE;
  SELECT coalesce((SELECT c.documento_novo FROM public.empresa_documento_continuidades c WHERE c.empresa_id = NEW.empresa_id
                    ORDER BY c.registrada_em DESC, c.id DESC LIMIT 1), vigente) INTO vigente;
  IF vigente IS NULL OR vigente <> NEW.documento_anterior THEN
    RAISE EXCEPTION '091: o documento anterior da continuidade não é o documento vigente da empresa.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER empresa_documento_continuidades_091_guarda BEFORE INSERT OR UPDATE OR DELETE ON empresa_documento_continuidades
  FOR EACH ROW EXECUTE FUNCTION kidmais_091_continuidade_guarda();
COMMENT ON TABLE empresa_documento_continuidades IS '091: continuidade assistida do documento da contratante (retificação, CPF → CNPJ), com instrumento e evidências; snapshots preservados.';

COMMENT ON FUNCTION kidmais_091_documento_valido(text) IS '091: DV oficial de CPF e CNPJ (numérico e alfanumérico). Não prova titularidade.';
COMMIT;
