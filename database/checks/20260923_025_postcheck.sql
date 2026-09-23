-- Somente leitura. Não atualiza históricos.
DO $$ BEGIN
  IF (SELECT count(*) FROM tabelas_preco WHERE ativa AND vigencia_inicio<=CURRENT_DATE
      AND (vigencia_fim IS NULL OR vigencia_fim>=CURRENT_DATE)) <> 1
    OR NOT EXISTS (SELECT 1 FROM tabelas_preco WHERE codigo='COMERCIAL_2026_09_EXTRAS_V3'
      AND ativa AND vigencia_inicio<=CURRENT_DATE AND vigencia_fim IS NULL) THEN
    RAISE EXCEPTION '025: vigência incorreta.';
  END IF;
  IF (SELECT count(*) FROM adicionais a JOIN precos_adicional x ON x.adicional_id=a.id
      JOIN tabelas_preco t ON t.id=x.tabela_preco_id WHERE t.codigo='COMERCIAL_2026_09_EXTRAS_V3'
      AND a.ativo AND x.ativo AND a.unidade_cobranca='UNIDADE' AND x.convidados_min=1 AND x.convidados_max=150
      AND ((a.codigo='BOMBOM' AND x.valor=4) OR (a.codigo='LEMBRANCINHA_COPO' AND x.valor=9)
        OR (a.codigo='LEMBRANCINHA_BOLA' AND x.valor=12))) <> 3
    OR EXISTS (SELECT 1 FROM adicionais WHERE codigo IN ('LEMBRANCINHA_PERSONALIZADA','LEMBRANCINHA_PREMIUM') AND ativo) THEN
    RAISE EXCEPTION '025: extras unitários ou SKUs suspensos divergentes.';
  END IF;
  IF EXISTS (SELECT 1 FROM adicionais a WHERE a.ativo AND EXISTS
      (SELECT 1 FROM precos_adicional x JOIN tabelas_preco t ON t.id=x.tabela_preco_id
       WHERE t.codigo='COMERCIAL_2026_09_EXTRAS_V3' AND x.ativo AND x.adicional_id=a.id)
      AND NOT EXISTS (SELECT 1 FROM pacote_adicionais pa JOIN pacotes p ON p.id=pa.pacote_id
       WHERE p.codigo='PIZZA_PARTY' AND pa.adicional_id=a.id AND pa.ativo AND pa.modalidade='EXTRA'))
    OR EXISTS (SELECT 1 FROM precos_pacote x JOIN pacotes p ON p.id=x.pacote_id WHERE p.codigo='PIZZA_PARTY')
    OR EXISTS (SELECT 1 FROM regras_disponibilidade_pacote r JOIN pacotes p ON p.id=r.pacote_id
      WHERE p.codigo='PIZZA_PARTY' AND r.ativo AND r.estado<>'SOB_CONSULTA') THEN
    RAISE EXCEPTION '025: Pizza Party diverge da regra aprovada.';
  END IF;
  IF EXISTS (
    SELECT a.codigo,x.convidados_min,x.convidados_max,x.valor,x.ativo FROM precos_adicional x
      JOIN adicionais a ON a.id=x.adicional_id JOIN tabelas_preco t ON t.id=x.tabela_preco_id
      WHERE t.codigo='COMERCIAL_2026_09_ROLHA_V2' AND a.codigo<>'BOMBOM'
    EXCEPT
    SELECT a.codigo,x.convidados_min,x.convidados_max,x.valor,x.ativo FROM precos_adicional x
      JOIN adicionais a ON a.id=x.adicional_id JOIN tabelas_preco t ON t.id=x.tabela_preco_id
      WHERE t.codigo='COMERCIAL_2026_09_EXTRAS_V3') THEN
    RAISE EXCEPTION '025: preços/faixas anteriores não preservados.';
  END IF;
END $$;
SELECT 'pos_025' marco, (SELECT count(*) FROM fechamentos) fechamentos;
