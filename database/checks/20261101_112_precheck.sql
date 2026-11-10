-- 112 precheck PREPARADO, NÃO EXECUTADO. Somente leitura. Exige 009/054/076 e a ausência de qualquer objeto da 112.
BEGIN TRANSACTION READ ONLY;
SET LOCAL search_path = public, pg_catalog;
DO $$ BEGIN
  IF to_regclass('public.clientes') IS NULL THEN RAISE EXCEPTION '112 precheck: clientes ausente'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.clientes'::regclass AND attname = 'empresa_id' AND NOT attisdropped)
     OR NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.clientes'::regclass AND attname = 'rg' AND NOT attisdropped)
    THEN RAISE EXCEPTION '112 precheck: 009/054 ausentes'; END IF;
  IF to_regclass('public.clientes_cpf_empresa_canonico_uk') IS NULL
    THEN RAISE EXCEPTION '112 precheck: 076 ausente (CPF único por empresa)'; END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.clientes'::regclass AND NOT attisdropped
       AND attname IN ('tipo_pessoa','cnpj','razao_social','nome_fantasia','representante_nome','representante_cpf'))
     OR EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.clientes'::regclass AND conname LIKE 'clientes\_112\_%')
     OR to_regclass('public.clientes_cnpj_empresa_canonico_uk') IS NOT NULL
     OR to_regprocedure('public.kidmais_112_cnpj_valido(text)') IS NOT NULL
     OR to_regprocedure('public.kidmais_112_cpf_valido(text)') IS NOT NULL
     OR to_regprocedure('public.kidmais_112_mesclagem_mesmo_tipo()') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgname IN ('clientes_112_mesclagem_mesmo_tipo','mesclagens_clientes_112_mesmo_tipo'))
    THEN RAISE EXCEPTION '112 precheck: 112 já (parcialmente) presente'; END IF;
  IF to_regclass('public.mesclagens_clientes') IS NULL THEN RAISE EXCEPTION '112 precheck: 004 ausente (mesclagens_clientes)'; END IF;
END $$;
SELECT current_database() AS banco, (SELECT count(*) FROM clientes) AS clientes, true AS aprovado;
ROLLBACK;
