-- 078 precheck PREPARADO, NÃO EXECUTADO. Somente leitura.
BEGIN TRANSACTION READ ONLY;
SET LOCAL search_path = public, pg_catalog;
DO $$ BEGIN
  IF to_regclass('public.buffet_categorias') IS NULL OR to_regclass('public.pacote_itens_especificos') IS NULL THEN
    RAISE EXCEPTION '078 precheck: catálogo (021/050) ausente.';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'buffet_categorias' AND column_name = 'empresa_id') THEN
    RAISE EXCEPTION '078 precheck: já aplicada.';
  END IF;
  IF (SELECT count(*) FROM empresas WHERE codigo = 'kidmais') > 1 THEN
    RAISE EXCEPTION '078 precheck: mais de uma empresa kidmais.';
  END IF;
END $$;
-- Informativo: dono do catálogo atual e tamanho dele.
SELECT current_database() AS banco,
       (SELECT count(*) FROM empresas WHERE codigo = 'kidmais') AS empresas_kidmais,
       (SELECT count(*) FROM buffet_categorias) AS categorias, (SELECT count(*) FROM buffet_itens) AS itens;
-- Informativo: OUTRAS empresas que receberão cópia só do que já usam (pacotes ou adicionais do buffet).
WITH k AS (SELECT id FROM empresas WHERE codigo = 'kidmais'),
uso AS (
  SELECT p.empresa_id, pbc.categoria_id FROM pacote_buffet_categorias pbc JOIN pacotes p ON p.id = pbc.pacote_id
  UNION SELECT p.empresa_id, i.categoria_id FROM pacote_itens_especificos pe JOIN pacotes p ON p.id = pe.pacote_id JOIN buffet_itens i ON i.id = pe.item_id
  UNION SELECT a.empresa_id, a.origem_buffet_categoria_id FROM adicionais a WHERE a.origem_buffet_categoria_id IS NOT NULL
  UNION SELECT a.empresa_id, i.categoria_id FROM adicionais a JOIN buffet_itens i ON i.id = a.origem_buffet_item_id
)
SELECT e.codigo AS empresa_que_recebe_copia,
       count(DISTINCT uso.categoria_id) FILTER (WHERE uso.categoria_id IS NOT NULL) AS categorias_usadas,
       bool_or(uso.categoria_id IS NULL) AS usa_item_sem_categoria
  FROM uso JOIN empresas e ON e.id = uso.empresa_id
 WHERE uso.empresa_id IS DISTINCT FROM (SELECT id FROM k)
 GROUP BY e.codigo ORDER BY e.codigo;
-- Informativo: pacotes SEM empresa (legado) ligados ao catálogo — continuam ligados; mudanças futuras neles são recusadas.
SELECT count(*) AS pacotes_sem_empresa_com_buffet
  FROM (SELECT DISTINCT pbc.pacote_id FROM pacote_buffet_categorias pbc JOIN pacotes p ON p.id = pbc.pacote_id WHERE p.empresa_id IS NULL) x;
ROLLBACK;
