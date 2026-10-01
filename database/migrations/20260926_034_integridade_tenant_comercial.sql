BEGIN;

-- Integridade de tenant nos vínculos comerciais. Não cria membership nem copia a 020.
-- Não associa os sete pacotes legados a uma empresa.
--
-- Estratégia operacional:
-- Rollback possível: database/rollback/20260926_034_integridade_tenant_comercial_down.sql
-- remove só função e gatilhos. Não apaga linha e não reescreve empresa_id.
-- O precheck recusa se já existir vínculo cruzado. Essa recusa não autoriza
-- apagar nem reatribuir a linha. A migration em si não corrige histórico:
-- instala a guarda só para INSERT/UPDATE futuro.
-- Aplicação anterior com este schema aditivo: vínculos da mesma empresa e o
-- par legado (as duas empresas nulas) continuam válidos. Vínculo novo com
-- empresas distintas, ou só um lado nulo, falha no gatilho.

DO $$ BEGIN
  IF to_regclass('public.precos_pacote') IS NULL
     OR to_regclass('public.pacote_adicionais') IS NULL
     OR to_regclass('public.precos_adicional') IS NULL
     OR to_regclass('public.pacotes') IS NULL
     OR to_regclass('public.tabelas_preco') IS NULL
     OR to_regclass('public.adicionais') IS NULL THEN
    RAISE EXCEPTION '034: catálogo comercial ausente.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'pacotes' AND column_name = 'empresa_id'
  ) THEN
    RAISE EXCEPTION '034: empresa_id comercial ausente.';
  END IF;
  IF to_regprocedure('public.kidmais_034_recusar_empresa_distinta(uuid,uuid,text)') IS NOT NULL THEN
    RAISE EXCEPTION '034: integridade de tenant já existe.';
  END IF;
END $$;

CREATE FUNCTION kidmais_034_recusar_empresa_distinta(esquerda uuid, direita uuid, relacao text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF esquerda IS DISTINCT FROM direita THEN
    RAISE EXCEPTION '034: % cruza empresas.', relacao
      USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE FUNCTION kidmais_034_precos_pacote_empresa()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  empresa_tabela uuid;
  empresa_pacote uuid;
BEGIN
  SELECT empresa_id INTO empresa_tabela FROM tabelas_preco WHERE id = NEW.tabela_preco_id;
  SELECT empresa_id INTO empresa_pacote FROM pacotes WHERE id = NEW.pacote_id;
  PERFORM kidmais_034_recusar_empresa_distinta(empresa_tabela, empresa_pacote, 'preco de pacote');
  RETURN NEW;
END;
$$;

CREATE FUNCTION kidmais_034_pacote_adicionais_empresa()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  empresa_pacote uuid;
  empresa_adicional uuid;
BEGIN
  SELECT empresa_id INTO empresa_pacote FROM pacotes WHERE id = NEW.pacote_id;
  SELECT empresa_id INTO empresa_adicional FROM adicionais WHERE id = NEW.adicional_id;
  PERFORM kidmais_034_recusar_empresa_distinta(empresa_pacote, empresa_adicional, 'adicional de pacote');
  RETURN NEW;
END;
$$;

CREATE FUNCTION kidmais_034_precos_adicional_empresa()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  empresa_tabela uuid;
  empresa_adicional uuid;
BEGIN
  SELECT empresa_id INTO empresa_tabela FROM tabelas_preco WHERE id = NEW.tabela_preco_id;
  SELECT empresa_id INTO empresa_adicional FROM adicionais WHERE id = NEW.adicional_id;
  PERFORM kidmais_034_recusar_empresa_distinta(empresa_tabela, empresa_adicional, 'preco de adicional');
  RETURN NEW;
END;
$$;

CREATE TRIGGER precos_pacote_empresa_trg
BEFORE INSERT OR UPDATE OF tabela_preco_id, pacote_id ON precos_pacote
FOR EACH ROW
EXECUTE FUNCTION kidmais_034_precos_pacote_empresa();

CREATE TRIGGER pacote_adicionais_empresa_trg
BEFORE INSERT OR UPDATE OF pacote_id, adicional_id ON pacote_adicionais
FOR EACH ROW
EXECUTE FUNCTION kidmais_034_pacote_adicionais_empresa();

CREATE TRIGGER precos_adicional_empresa_trg
BEFORE INSERT OR UPDATE OF tabela_preco_id, adicional_id ON precos_adicional
FOR EACH ROW
EXECUTE FUNCTION kidmais_034_precos_adicional_empresa();

COMMIT;
