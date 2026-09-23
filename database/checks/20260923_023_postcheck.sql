-- Somente leitura; comparar fechamentos com o precheck.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pacote_adicionais pa
    JOIN pacotes p ON p.id=pa.pacote_id JOIN adicionais a ON a.id=pa.adicional_id
    WHERE p.codigo='PREMIUM' AND a.codigo='EMPRATADO_PREMIUM' AND pa.modalidade='INCLUSO') OR
     EXISTS (SELECT 1 FROM pacote_adicionais pa
    JOIN pacotes p ON p.id=pa.pacote_id JOIN adicionais a ON a.id=pa.adicional_id
    WHERE p.codigo='PREMIUM' AND a.codigo='EMPRATADO_PREMIUM' AND pa.modalidade='EXTRA') THEN
    RAISE EXCEPTION 'Premium não pode cobrar empratado já incluso.';
  END IF;
END $$;
SELECT 'pos_023' AS marco,(SELECT count(*) FROM fechamentos) AS fechamentos;
