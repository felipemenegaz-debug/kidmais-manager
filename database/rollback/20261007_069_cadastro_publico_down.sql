-- 069 rollback. Recusa com qualquer pedido de cadastro, aceite, empresa cadastrada, sócio ou pedido de acesso
-- registrado (não apaga dado de cadastro).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = public, pg_catalog;

DO $$ BEGIN
  IF to_regclass('public.cadastros_publicos') IS NULL THEN RAISE EXCEPTION '069 rollback: 069 não aplicada.'; END IF;
END $$;

LOCK TABLE cadastros_publicos, aceites_documentos_legais, cadastros_empresas, empresa_socios, solicitacoes_acesso_empresa IN ACCESS EXCLUSIVE MODE;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM cadastros_publicos) OR EXISTS (SELECT 1 FROM aceites_documentos_legais) OR EXISTS (SELECT 1 FROM cadastros_empresas)
     OR EXISTS (SELECT 1 FROM empresa_socios) OR EXISTS (SELECT 1 FROM solicitacoes_acesso_empresa) THEN
    RAISE EXCEPTION '069 rollback recusado: há dados de cadastro público registrados.';
  END IF;
END $$;

DROP TABLE solicitacoes_acesso_empresa;
DROP TABLE empresa_socios;
DROP TABLE cadastros_empresas;
DROP TABLE aceites_documentos_legais;
DROP TABLE cadastros_publicos;
DROP FUNCTION kidmais_069_cadastro_guarda();
DROP FUNCTION kidmais_069_somente_insercao();

COMMIT;
