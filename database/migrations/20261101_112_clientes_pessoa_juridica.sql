-- 112 — Cliente pessoa jurídica (Entrega B do plano "importação de contrato com dados completos", rev. 2.1 APROVADO).
-- LOCAL, preparada em 01/11/2026. NÃO aplicada em staging/produção. Exige 002, 009 (rg) e 054 (empresa_id).
-- Ordem: código compatível publicado ANTES (sem a 112 o servidor recusa PJ com PJ_INDISPONIVEL / MIGRACAO_PENDENTE) →
-- conferência → autorização → aplicação → postcheck.
-- O que muda (só acréscimos; nenhuma linha é atualizada):
--   clientes.tipo_pessoa ('PF' padrão | 'PJ'), cnpj (14, numérico ou alfanumérico, DV conferido no banco), razao_social,
--   nome_fantasia, representante_nome, representante_cpf (DV de CPF).
--   PF ⇒ os cinco campos de PJ nulos (o rollback nunca perde dado de PF). PJ ⇒ cnpj e razao_social obrigatórios, cpf nulo,
--   razao_social = nome_completo (a busca e as telas atuais seguem pelo nome_completo).
--   CNPJ único por empresa fora de MESCLADO, no molde da 076.
--   Mesclagem só entre clientes do mesmo tipo (R2-5): gatilhos em clientes (cliente_principal_id, tipo_pessoa) e em
--   mesclagens_clientes. Hoje nenhuma tela mescla; a regra fica no banco para qualquer caminho futuro.
-- DV próprio (kidmais_112_*): a 091 (documento fiscal da assinatura) não é pré-requisito em todos os ambientes.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'clientes' AND column_name = 'empresa_id')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'clientes' AND column_name = 'rg') THEN
    RAISE EXCEPTION '112 exige 009 (clientes.rg) e 054 (clientes.empresa_id).';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'clientes'
       AND column_name IN ('tipo_pessoa','cnpj','razao_social','nome_fantasia','representante_nome','representante_cpf'))
     OR to_regclass('public.clientes_cnpj_empresa_canonico_uk') IS NOT NULL
     OR to_regprocedure('public.kidmais_112_cnpj_valido(text)') IS NOT NULL
     OR to_regprocedure('public.kidmais_112_cpf_valido(text)') IS NOT NULL
     OR to_regprocedure('public.kidmais_112_mesclagem_mesmo_tipo()') IS NOT NULL THEN
    RAISE EXCEPTION '112 já aplicada total ou parcialmente.';
  END IF;
END $$;

-- ACCESS EXCLUSIVE já de início: os ALTER abaixo precisam dele (sem subir a trava no meio).
LOCK TABLE clientes IN ACCESS EXCLUSIVE MODE;

-- DV oficial de CPF (11 dígitos, sem sequência repetida, módulo 11). Mesmo critério de cpfValidoServico.
CREATE FUNCTION kidmais_112_cpf_valido(doc text) RETURNS boolean
  LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog, pg_temp AS $$
DECLARE soma integer; d1 integer; d2 integer; i integer;
BEGIN
  IF doc !~ '^[0-9]{11}$' OR doc ~ '^(.)\1{10}$' THEN RETURN false; END IF;
  soma := 0; FOR i IN 1..9 LOOP soma := soma + (ascii(substr(doc,i,1)) - 48) * (11 - i); END LOOP;
  d1 := (soma * 10) % 11; IF d1 = 10 THEN d1 := 0; END IF;
  soma := 0; FOR i IN 1..10 LOOP soma := soma + (ascii(substr(doc,i,1)) - 48) * (12 - i); END LOOP;
  d2 := (soma * 10) % 11; IF d2 = 10 THEN d2 := 0; END IF;
  RETURN d1 = ascii(substr(doc,10,1)) - 48 AND d2 = ascii(substr(doc,11,1)) - 48;
END $$;

-- DV oficial de CNPJ numérico/alfanumérico (ASCII − 48, pesos 2–9), mesmo critério de lib/cadastro/cnpj.ts
-- (cnpjFormatoDvOficial). A raiz repetida é política local do código, não do banco.
CREATE FUNCTION kidmais_112_cnpj_valido(doc text) RETURNS boolean
  LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog, pg_temp AS $$
DECLARE soma integer; peso integer; d1 integer; d2 integer; i integer;
BEGIN
  IF doc !~ '^[0-9A-Z]{12}[0-9]{2}$' THEN RETURN false; END IF;
  soma := 0; peso := 2; FOR i IN REVERSE 12..1 LOOP soma := soma + (ascii(substr(doc,i,1)) - 48) * peso; peso := CASE WHEN peso = 9 THEN 2 ELSE peso + 1 END; END LOOP;
  d1 := CASE WHEN soma % 11 <= 1 THEN 0 ELSE 11 - soma % 11 END;
  soma := d1 * 2; peso := 3; FOR i IN REVERSE 12..1 LOOP soma := soma + (ascii(substr(doc,i,1)) - 48) * peso; peso := CASE WHEN peso = 9 THEN 2 ELSE peso + 1 END; END LOOP;
  d2 := CASE WHEN soma % 11 <= 1 THEN 0 ELSE 11 - soma % 11 END;
  RETURN d1 = ascii(substr(doc,13,1)) - 48 AND d2 = ascii(substr(doc,14,1)) - 48;
END $$;

-- DEFAULT constante: acréscimo só de catálogo (sem reescrever a tabela).
ALTER TABLE clientes
  ADD COLUMN tipo_pessoa text NOT NULL DEFAULT 'PF',
  ADD COLUMN cnpj text,
  ADD COLUMN razao_social text,
  ADD COLUMN nome_fantasia text,
  ADD COLUMN representante_nome text,
  ADD COLUMN representante_cpf char(11);

-- Os CHECKs valem em INSERT e UPDATE; todas as linhas existentes já os satisfazem (PF com as colunas novas nulas).
ALTER TABLE clientes
  ADD CONSTRAINT clientes_112_tipo_pessoa_check CHECK (tipo_pessoa IN ('PF','PJ')),
  ADD CONSTRAINT clientes_112_cnpj_formato CHECK (cnpj IS NULL OR kidmais_112_cnpj_valido(cnpj)),
  ADD CONSTRAINT clientes_112_representante_cpf_formato CHECK (representante_cpf IS NULL OR kidmais_112_cpf_valido(representante_cpf)),
  ADD CONSTRAINT clientes_112_textos_nao_vazios CHECK (
        (razao_social IS NULL OR btrim(razao_social) <> '')
    AND (nome_fantasia IS NULL OR btrim(nome_fantasia) <> '')
    AND (representante_nome IS NULL OR btrim(representante_nome) <> '')),
  ADD CONSTRAINT clientes_112_pf_sem_campos_pj CHECK (tipo_pessoa <> 'PF' OR (cnpj IS NULL AND razao_social IS NULL
    AND nome_fantasia IS NULL AND representante_nome IS NULL AND representante_cpf IS NULL)),
  ADD CONSTRAINT clientes_112_pj_identidade CHECK (tipo_pessoa <> 'PJ' OR (cnpj IS NOT NULL AND cpf IS NULL
    AND razao_social IS NOT NULL AND razao_social = nome_completo)),
  ADD CONSTRAINT clientes_112_representante_nome CHECK (representante_cpf IS NULL OR representante_nome IS NOT NULL);

CREATE UNIQUE INDEX clientes_cnpj_empresa_canonico_uk
  ON clientes (COALESCE(empresa_id, '00000000-0000-0000-0000-000000000000'::uuid), cnpj)
  WHERE cnpj IS NOT NULL AND status <> 'MESCLADO';

-- Mesclagem só entre clientes do mesmo tipo (R2-5). Em clientes: o secundário MESCLADO aponta para principal do mesmo
-- tipo, e trocar o tipo de um principal com secundários do outro tipo é recusado. Em mesclagens_clientes: os dois
-- clientes do registro têm o mesmo tipo. FOR SHARE trava a outra linha contra uma troca de tipo concorrente.
-- Todas as linhas atuais são PF: nenhuma é recusada na criação dos gatilhos.
CREATE FUNCTION kidmais_112_mesclagem_mesmo_tipo() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE outro text;
BEGIN
  IF TG_TABLE_NAME = 'mesclagens_clientes' THEN
    SELECT string_agg(DISTINCT c.tipo_pessoa, ',') INTO outro
      FROM (SELECT tipo_pessoa FROM public.clientes WHERE id IN (NEW.cliente_principal_id, NEW.cliente_secundario_id) FOR SHARE) c;
    IF outro LIKE '%,%' THEN
      RAISE EXCEPTION '112: mesclagem só entre clientes do mesmo tipo (PF com PF, PJ com PJ).' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.cliente_principal_id IS NOT NULL THEN
    SELECT tipo_pessoa INTO outro FROM public.clientes WHERE id = NEW.cliente_principal_id FOR SHARE;
    IF outro IS DISTINCT FROM NEW.tipo_pessoa THEN
      RAISE EXCEPTION '112: mesclagem só entre clientes do mesmo tipo (PF com PF, PJ com PJ).' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.tipo_pessoa IS DISTINCT FROM OLD.tipo_pessoa
     AND EXISTS (SELECT 1 FROM public.clientes s WHERE s.cliente_principal_id = NEW.id AND s.tipo_pessoa <> NEW.tipo_pessoa) THEN
    RAISE EXCEPTION '112: cliente principal de mesclagem não muda de tipo (há cadastro mesclado do outro tipo).' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER clientes_112_mesclagem_mesmo_tipo
  BEFORE INSERT OR UPDATE OF cliente_principal_id, tipo_pessoa ON clientes
  FOR EACH ROW EXECUTE FUNCTION kidmais_112_mesclagem_mesmo_tipo();
CREATE TRIGGER mesclagens_clientes_112_mesmo_tipo
  BEFORE INSERT OR UPDATE OF cliente_principal_id, cliente_secundario_id ON mesclagens_clientes
  FOR EACH ROW EXECUTE FUNCTION kidmais_112_mesclagem_mesmo_tipo();

COMMENT ON COLUMN clientes.tipo_pessoa IS '112: PF (padrão) ou PJ. PF usa cpf; PJ usa cnpj e razao_social (= nome_completo).';
COMMENT ON COLUMN clientes.cnpj IS '112: CNPJ do contratante PJ (14 caracteres, numérico ou alfanumérico, DV conferido). Chave de identidade da PJ.';
COMMENT ON COLUMN clientes.representante_cpf IS '112: CPF do representante legal da PJ. Texto contratual; nunca é chave de identidade nem de duplicidade.';

COMMIT;
