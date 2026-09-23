-- Somente leitura; comparar fechamentos com o precheck.
DO $$ BEGIN
  IF (SELECT count(*) FROM buffet_itens i JOIN buffet_categorias c ON c.id=i.categoria_id
      WHERE c.codigo='SALGADOS' AND i.ativo) <> 25 THEN
    RAISE EXCEPTION 'Lista de 25 salgados incompleta.';
  END IF;
  IF COALESCE((SELECT escolhas_max FROM pacote_buffet_categorias r
      JOIN buffet_categorias c ON c.id=r.categoria_id
      JOIN pacotes p ON p.id=r.pacote_id
      WHERE p.codigo='PREMIUM' AND c.codigo='EMPRATADOS'),0) <> 1 THEN
    RAISE EXCEPTION 'Regra do empratado premium ausente.';
  END IF;
END $$;
SELECT 'pos_022' AS marco,(SELECT count(*) FROM fechamentos) AS fechamentos;
