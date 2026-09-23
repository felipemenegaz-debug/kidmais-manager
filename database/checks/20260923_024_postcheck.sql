-- Somente leitura; comparar contagens anteriores, sem atualizar histórico.
DO $$ BEGIN
  IF (SELECT count(*) FROM precos_adicional x JOIN adicionais a ON a.id=x.adicional_id
    JOIN tabelas_preco t ON t.id=x.tabela_preco_id
    WHERE t.codigo='COMERCIAL_2026_09_ROLHA_V2' AND a.codigo='BEBIDA_ALCOOLICA') <> 2 OR
    NOT EXISTS (SELECT 1 FROM precos_adicional x JOIN adicionais a ON a.id=x.adicional_id
      JOIN tabelas_preco t ON t.id=x.tabela_preco_id WHERE t.codigo='COMERCIAL_2026_09_ROLHA_V2'
      AND a.codigo='BEBIDA_ALCOOLICA' AND x.convidados_min=1 AND x.convidados_max=79 AND x.valor=190) OR
    NOT EXISTS (SELECT 1 FROM precos_adicional x JOIN adicionais a ON a.id=x.adicional_id
      JOIN tabelas_preco t ON t.id=x.tabela_preco_id WHERE t.codigo='COMERCIAL_2026_09_ROLHA_V2'
      AND a.codigo='BEBIDA_ALCOOLICA' AND x.convidados_min=80 AND x.convidados_max=150 AND x.valor=290) THEN
    RAISE EXCEPTION 'Taxa de rolha versionada diverge das faixas aprovadas.';
  END IF;
END $$;
SELECT 'pos_024' AS marco,(SELECT count(*) FROM fechamentos) AS fechamentos,
 (SELECT count(*) FROM precos_pacote) AS precos_pacote,
 (SELECT count(*) FROM precos_adicional) AS precos_adicional;
