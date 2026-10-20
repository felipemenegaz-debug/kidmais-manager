-- 078 postcheck PREPARADO, NÃO EXECUTADO. Somente leitura.
BEGIN TRANSACTION READ ONLY;
SET LOCAL search_path = public, pg_catalog;
DO $$
DECLARE k uuid := (SELECT id FROM empresas WHERE codigo = 'kidmais');
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'buffet_itens' AND column_name = 'empresa_id') THEN
    RAISE EXCEPTION '078 postcheck: coluna empresa_id ausente.';
  END IF;
  IF k IS NOT NULL AND (EXISTS (SELECT 1 FROM buffet_categorias WHERE empresa_id IS NULL) OR EXISTS (SELECT 1 FROM buffet_itens WHERE empresa_id IS NULL)) THEN
    RAISE EXCEPTION '078 postcheck: catálogo sem empresa havendo kidmais.';
  END IF;
  IF k IS NOT NULL AND (SELECT count(*) FROM buffet_categorias WHERE empresa_id = k AND codigo IN
       ('SALGADOS','DOCES','MASSA_BOLO','RECHEIO_BOLO','BOMBONS','EMPRATADOS','LEMBRANCINHAS')) <> 7 THEN
    RAISE EXCEPTION '078 postcheck: categorias originais da Kidmais incompletas.';
  END IF;
  IF EXISTS (SELECT 1 FROM buffet_itens i JOIN buffet_categorias c ON c.id = i.categoria_id WHERE i.empresa_id IS DISTINCT FROM c.empresa_id) THEN
    RAISE EXCEPTION '078 postcheck: item em categoria de outra empresa.';
  END IF;
  IF EXISTS (SELECT 1 FROM pacote_buffet_categorias x JOIN pacotes p ON p.id = x.pacote_id JOIN buffet_categorias c ON c.id = x.categoria_id
              WHERE p.empresa_id IS NOT NULL AND p.empresa_id IS DISTINCT FROM c.empresa_id)
     OR EXISTS (SELECT 1 FROM pacote_buffet_itens x JOIN pacotes p ON p.id = x.pacote_id JOIN buffet_itens i ON i.id = x.item_id
              WHERE p.empresa_id IS NOT NULL AND p.empresa_id IS DISTINCT FROM i.empresa_id)
     OR EXISTS (SELECT 1 FROM pacote_itens_especificos x JOIN pacotes p ON p.id = x.pacote_id JOIN buffet_itens i ON i.id = x.item_id
              WHERE p.empresa_id IS NOT NULL AND p.empresa_id IS DISTINCT FROM i.empresa_id)
     OR EXISTS (SELECT 1 FROM adicionais a JOIN buffet_categorias c ON c.id = a.origem_buffet_categoria_id WHERE a.empresa_id IS DISTINCT FROM c.empresa_id)
     OR EXISTS (SELECT 1 FROM adicionais a JOIN buffet_itens i ON i.id = a.origem_buffet_item_id WHERE a.empresa_id IS DISTINCT FROM i.empresa_id) THEN
    RAISE EXCEPTION '078 postcheck: vínculo de buffet entre empresas distintas.';
  END IF;
  IF to_regclass('public.buffet_categorias_empresa_codigo_uk') IS NULL OR to_regclass('public.buffet_itens_empresa_codigo_sem_categoria_uk') IS NULL THEN
    RAISE EXCEPTION '078 postcheck: índices únicos por empresa ausentes.';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgname IN ('buffet_categorias_empresa_imutavel_trg','buffet_itens_empresa_imutavel_trg',
       'buffet_itens_categoria_empresa_trg','pacote_buffet_categorias_empresa_trg','pacote_buffet_itens_empresa_trg',
       'pacote_itens_especificos_empresa_trg','adicionais_origem_buffet_empresa_trg','fechamento_buffet_escolhas_empresa_trg')) <> 8 THEN
    RAISE EXCEPTION '078 postcheck: gatilhos de integridade ausentes.';
  END IF;
END $$;
SELECT current_database() AS banco,
       (SELECT count(DISTINCT empresa_id) FROM buffet_categorias) AS empresas_com_catalogo,
       (SELECT count(*) FROM buffet_categorias c JOIN empresas e ON e.id = c.empresa_id WHERE e.codigo = 'kidmais') AS categorias_kidmais,
       true AS aprovado;
ROLLBACK;
