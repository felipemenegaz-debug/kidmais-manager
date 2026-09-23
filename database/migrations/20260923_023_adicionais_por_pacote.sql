BEGIN;

-- Disponibilidade explícita para os adicionais já precificados no catálogo V1.
-- Ausência de vínculo significa indisponível. Não altera preços nem contratos.
WITH regras(pacote,adicional,modalidade) AS (
  SELECT p.codigo,a.codigo,
    CASE
      WHEN a.codigo IN ('PENNE','CREPE_1_SABOR','SORVETE')
           AND p.codigo IN ('COMPLETA','PREMIUM') THEN 'INCLUSO'
      WHEN a.codigo IN ('COMBO_ADULTOS','COMBO_LANCHINHOS')
           AND p.codigo = 'PREMIUM' THEN 'INCLUSO'
      WHEN a.codigo IN ('COMBO_ADULTOS','COMBO_LANCHINHOS')
           AND p.codigo = 'COMPLETA' THEN 'INDISPONIVEL'
      WHEN a.codigo = 'SALADA_PREMIUM' AND p.codigo = 'PREMIUM' THEN 'INCLUSO'
      WHEN a.codigo IN ('SALADA_PREMIUM','CREPE_2_SABORES','PASTELZINHO')
           AND p.codigo = 'PREMIUM' THEN 'INCLUSO'
      WHEN a.codigo = 'EMPRATADO_PREMIUM' AND p.codigo = 'PREMIUM' THEN 'INCLUSO'
      WHEN a.codigo = 'BOMBOM' AND p.codigo = 'PREMIUM' THEN 'EXTRA'
      WHEN a.codigo IN ('LEMBRANCINHA_PERSONALIZADA','LEMBRANCINHA_PREMIUM')
           AND p.codigo IN ('MINI_FESTA','COMPLETA','PREMIUM') THEN 'EXTRA'
      ELSE 'EXTRA'
    END
  FROM pacotes p CROSS JOIN adicionais a
  WHERE p.codigo IN ('POCKET','MINI_FESTA','COMPACTA','ESSENCIAL','COMPLETA','PREMIUM')
    AND a.codigo NOT IN ('BEBIDA_ALCOOLICA')
)
INSERT INTO pacote_adicionais(pacote_id,adicional_id,modalidade)
SELECT p.id,a.id,r.modalidade FROM regras r
JOIN pacotes p ON p.codigo=r.pacote JOIN adicionais a ON a.codigo=r.adicional
ON CONFLICT (pacote_id,adicional_id) DO NOTHING;

-- A taxa de rolha é uma contratação adicional, nunca um item incluso.
INSERT INTO pacote_adicionais(pacote_id,adicional_id,modalidade)
SELECT p.id,a.id,'EXTRA' FROM pacotes p CROSS JOIN adicionais a
WHERE p.codigo IN ('POCKET','MINI_FESTA','COMPACTA','ESSENCIAL','COMPLETA','PREMIUM')
  AND a.codigo='BEBIDA_ALCOOLICA'
ON CONFLICT (pacote_id,adicional_id) DO NOTHING;

COMMIT;
