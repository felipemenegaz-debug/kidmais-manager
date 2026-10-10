-- 076 postcheck PREPARADO, NÃO EXECUTADO. Somente leitura.
BEGIN TRANSACTION READ ONLY;
SET LOCAL search_path = public, pg_catalog;
DO $$ BEGIN
  IF to_regclass('public.clientes_cpf_canonico_uk') IS NOT NULL THEN
    RAISE EXCEPTION '076 postcheck: índice global ainda existe.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indexrelid = to_regclass('public.clientes_cpf_empresa_canonico_uk')
       AND i.indisunique AND i.indisvalid AND i.indrelid = 'public.clientes'::regclass
       AND pg_get_expr(i.indpred, i.indrelid) LIKE '%cpf IS NOT NULL%' AND pg_get_expr(i.indpred, i.indrelid) LIKE '%MESCLADO%') THEN
    RAISE EXCEPTION '076 postcheck: índice por empresa ausente, inválido ou com predicado divergente.';
  END IF;
END $$;
SELECT current_database() AS banco, 'clientes_cpf_empresa_canonico_uk' AS indice, true AS aprovado;
ROLLBACK;
