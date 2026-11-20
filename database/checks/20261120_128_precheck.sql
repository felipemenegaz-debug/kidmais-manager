-- 128 precheck PREPARADO, NÃO EXECUTADO. Somente leitura. Confere a 021 e nada da 128.
BEGIN TRANSACTION READ ONLY;
SET LOCAL search_path = public, pg_catalog;
DO $$
BEGIN
  IF to_regclass('public.documentos_publicos') IS NULL THEN
    RAISE EXCEPTION '128 precheck: exige a 021';
  END IF;
  IF to_regclass('public.disponibilidade_config_legada') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.documentos_publicos'::regclass
                  AND attname = 'conteudo' AND NOT attisdropped) THEN
    RAISE EXCEPTION '128 precheck: 128 já presente (inteira ou parcial)';
  END IF;
END $$;
-- Quantos documentos a cópia do disco vai precisar preencher (sem conteúdo de cliente).
SELECT current_database() AS banco, true AS aprovado,
  (SELECT count(*) FROM documentos_publicos) AS documentos,
  (SELECT count(*) FROM documentos_publicos WHERE ativo) AS documentos_ativos;
ROLLBACK;
