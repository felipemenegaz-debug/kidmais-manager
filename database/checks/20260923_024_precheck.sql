-- Somente leitura; executar apenas em clone isolado autorizado.
DO $$ BEGIN
  IF (SELECT count(*) FROM tabelas_preco WHERE ativa AND vigencia_inicio<=CURRENT_DATE
      AND (vigencia_fim IS NULL OR vigencia_fim>=CURRENT_DATE)) <> 1 OR
     NOT EXISTS (SELECT 1 FROM tabelas_preco WHERE codigo='COMERCIAL_2026_09'
      AND ativa AND vigencia_inicio<CURRENT_DATE
      AND (vigencia_fim IS NULL OR vigencia_fim>=CURRENT_DATE)) THEN
    RAISE EXCEPTION 'Revisar a tabela vigente antes de executar 024.';
  END IF;
END $$;
SELECT 'pre_024' AS marco,(SELECT count(*) FROM fechamentos) AS fechamentos,
 (SELECT count(*) FROM precos_pacote) AS precos_pacote,
 (SELECT count(*) FROM precos_adicional) AS precos_adicional;
