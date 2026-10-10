-- 077 precheck PREPARADO, NÃO EXECUTADO. Somente leitura.
BEGIN TRANSACTION READ ONLY;
SET LOCAL search_path = public, pg_catalog;
DO $$ BEGIN
  IF to_regclass('public.empresas') IS NULL THEN
    RAISE EXCEPTION '077 precheck: empresas ausente.';
  END IF;
  IF to_regclass('public.empresa_regras_pagamento') IS NOT NULL THEN
    RAISE EXCEPTION '077 precheck: já aplicada.';
  END IF;
END $$;
-- Informativo: a empresa que receberá as regras legadas (deve ser exatamente uma neste banco).
SELECT current_database() AS banco,
       (SELECT count(*) FROM empresas WHERE codigo = 'kidmais') AS empresas_kidmais,
       (SELECT count(*) FROM empresas WHERE codigo = 'kidmais' AND status = 'ATIVA') AS kidmais_ativa;
ROLLBACK;
