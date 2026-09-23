-- Somente leitura. Não reaplicar 024 nem 025; qualquer divergência exige revisão.
DO $$ BEGIN
  IF (SELECT count(*) FROM tabelas_preco WHERE ativa AND vigencia_inicio<=CURRENT_DATE
      AND (vigencia_fim IS NULL OR vigencia_fim>=CURRENT_DATE)) <> 1
    OR NOT EXISTS (SELECT 1 FROM tabelas_preco WHERE codigo='COMERCIAL_2026_09_ROLHA_V2'
      AND ativa AND vigencia_inicio<=CURRENT_DATE AND vigencia_fim IS NULL)
    OR EXISTS (SELECT 1 FROM tabelas_preco WHERE codigo='COMERCIAL_2026_09_EXTRAS_V3') THEN
    RAISE EXCEPTION '025: tabela vigente inesperada ou migration já aplicada.';
  END IF;
  IF (SELECT count(*) FROM adicionais WHERE codigo IN
    ('BOMBOM','LEMBRANCINHA_PERSONALIZADA','LEMBRANCINHA_PREMIUM') AND ativo AND unidade_cobranca='UNIDADE') <> 3
    OR EXISTS (SELECT 1 FROM adicionais WHERE codigo IN ('LEMBRANCINHA_COPO','LEMBRANCINHA_BOLA')) THEN
    RAISE EXCEPTION '025: identidade dos SKUs diverge; não substituir produtos.';
  END IF;
  IF (SELECT count(*) FROM precos_adicional x JOIN adicionais a ON a.id=x.adicional_id
      JOIN tabelas_preco t ON t.id=x.tabela_preco_id
      WHERE t.codigo='COMERCIAL_2026_09_ROLHA_V2' AND a.codigo='BOMBOM'
        AND x.ativo AND x.convidados_min=1 AND x.convidados_max=150 AND x.valor=7) <> 1
    OR (SELECT count(*) FROM pacotes WHERE ativo AND codigo IN
      ('POCKET','MINI_FESTA','COMPACTA','ESSENCIAL','COMPLETA','PREMIUM','PIZZA_PARTY')) <> 7
    OR EXISTS (SELECT 1 FROM precos_pacote x JOIN pacotes p ON p.id=x.pacote_id
      WHERE p.codigo='PIZZA_PARTY')
    OR NOT EXISTS (SELECT 1 FROM regras_disponibilidade_pacote r JOIN pacotes p ON p.id=r.pacote_id
      WHERE p.codigo='PIZZA_PARTY' AND r.ativo AND r.estado='SOB_CONSULTA') THEN
    RAISE EXCEPTION '025: preços, pacotes ou Pizza Party inesperados.';
  END IF;
END $$;
SELECT 'pre_025' marco, (SELECT count(*) FROM fechamentos) fechamentos;
