BEGIN;
-- Nova tabela comercial. Nunca sobrescreve preços referenciados pelo histórico.
LOCK TABLE tabelas_preco, adicionais, precos_adicional, pacote_adicionais IN SHARE ROW EXCLUSIVE MODE;
DO $$ BEGIN
  IF (SELECT count(*) FROM tabelas_preco WHERE ativa AND vigencia_inicio<=CURRENT_DATE
      AND (vigencia_fim IS NULL OR vigencia_fim>=CURRENT_DATE)) <> 1
    OR NOT EXISTS (SELECT 1 FROM tabelas_preco WHERE codigo='COMERCIAL_2026_09_ROLHA_V2'
      AND ativa AND vigencia_inicio<=CURRENT_DATE AND vigencia_fim IS NULL)
    OR EXISTS (SELECT 1 FROM tabelas_preco WHERE codigo='COMERCIAL_2026_09_EXTRAS_V3')
    OR (SELECT count(*) FROM adicionais WHERE codigo IN ('BOMBOM','LEMBRANCINHA_PERSONALIZADA','LEMBRANCINHA_PREMIUM')
      AND ativo AND unidade_cobranca='UNIDADE') <> 3
    OR EXISTS (SELECT 1 FROM adicionais WHERE codigo IN ('LEMBRANCINHA_COPO','LEMBRANCINHA_BOLA')) THEN
    RAISE EXCEPTION '025: pré-condições divergentes ou migration já aplicada.';
  END IF;
END $$;

INSERT INTO adicionais(codigo,nome,descricao,categoria,categoria_id,unidade_cobranca,ordem_exibicao)
SELECT v.codigo,v.nome,v.descricao,'EXTRA',base.categoria_id,'UNIDADE',v.ordem
FROM (VALUES ('LEMBRANCINHA_COPO','Lembrancinha extra — Copo','Copo extra por unidade; não substitui lembrancinha personalizada.',32),
       ('LEMBRANCINHA_BOLA','Lembrancinha extra — Bola','Bola extra por unidade; não substitui lembrancinha premium.',33)) v(codigo,nome,descricao,ordem)
JOIN adicionais base ON base.codigo='LEMBRANCINHA_PERSONALIZADA';

INSERT INTO tabelas_preco(codigo,nome,vigencia_inicio,ativa,observacoes)
VALUES ('COMERCIAL_2026_09_EXTRAS_V3','Tabela comercial — extras por unidade',CURRENT_DATE,true,
  'Bombom extra R$4; Copo R$9; Bola R$12. Sem mínimo de compra; quantidade cobrada somente de extras.');

INSERT INTO precos_pacote(tabela_preco_id,pacote_id,convidados_min,convidados_max,tipo_calculo,valor,categoria_horario,observacoes,ativo)
SELECT novo.id,x.pacote_id,x.convidados_min,x.convidados_max,x.tipo_calculo,x.valor,x.categoria_horario,x.observacoes,x.ativo
FROM precos_pacote x JOIN tabelas_preco antiga ON antiga.id=x.tabela_preco_id
CROSS JOIN tabelas_preco novo
WHERE antiga.codigo='COMERCIAL_2026_09_ROLHA_V2' AND novo.codigo='COMERCIAL_2026_09_EXTRAS_V3';

INSERT INTO precos_adicional(tabela_preco_id,adicional_id,convidados_min,convidados_max,valor,observacoes,ativo)
SELECT novo.id,x.adicional_id,x.convidados_min,x.convidados_max,
  CASE WHEN a.codigo='BOMBOM' THEN 4.00 ELSE x.valor END,
  CASE WHEN a.codigo='BOMBOM' THEN 'Somente bombons extras por unidade. Premium inclui 4; não cobrar os incluídos.' ELSE x.observacoes END,x.ativo
FROM precos_adicional x JOIN tabelas_preco antiga ON antiga.id=x.tabela_preco_id
JOIN adicionais a ON a.id=x.adicional_id CROSS JOIN tabelas_preco novo
WHERE antiga.codigo='COMERCIAL_2026_09_ROLHA_V2' AND novo.codigo='COMERCIAL_2026_09_EXTRAS_V3';

INSERT INTO precos_adicional(tabela_preco_id,adicional_id,convidados_min,convidados_max,valor,observacoes)
SELECT t.id,a.id,1,150,CASE a.codigo WHEN 'LEMBRANCINHA_COPO' THEN 9.00 ELSE 12.00 END,
  'Somente unidades extras selecionadas; sem mínimo de compra.'
FROM tabelas_preco t CROSS JOIN adicionais a
WHERE t.codigo='COMERCIAL_2026_09_EXTRAS_V3' AND a.codigo IN ('LEMBRANCINHA_COPO','LEMBRANCINHA_BOLA');

-- Preserva nomes, IDs e preços históricos. Suspende oferta de produtos não confirmados.
UPDATE adicionais SET ativo=false WHERE codigo IN ('LEMBRANCINHA_PERSONALIZADA','LEMBRANCINHA_PREMIUM');
UPDATE pacote_adicionais SET ativo=false WHERE adicional_id IN
  (SELECT id FROM adicionais WHERE codigo IN ('LEMBRANCINHA_PERSONALIZADA','LEMBRANCINHA_PREMIUM'));

INSERT INTO pacote_adicionais(pacote_id,adicional_id,modalidade)
SELECT p.id,a.id,'EXTRA' FROM pacotes p CROSS JOIN adicionais a
WHERE p.ativo AND p.codigo IN ('POCKET','MINI_FESTA','COMPACTA','ESSENCIAL','COMPLETA','PREMIUM','PIZZA_PARTY')
  AND a.codigo IN ('LEMBRANCINHA_COPO','LEMBRANCINHA_BOLA');

-- Pizza utiliza os mesmos IDs/regras de preços e faixas; sua base segue SOB_CONSULTA.
INSERT INTO pacote_adicionais(pacote_id,adicional_id,modalidade)
SELECT p.id,a.id,'EXTRA' FROM pacotes p CROSS JOIN adicionais a
WHERE p.codigo='PIZZA_PARTY' AND a.ativo AND EXISTS
 (SELECT 1 FROM precos_adicional x JOIN tabelas_preco t ON t.id=x.tabela_preco_id
  WHERE x.adicional_id=a.id AND x.ativo AND t.codigo='COMERCIAL_2026_09_EXTRAS_V3')
ON CONFLICT (pacote_id,adicional_id) DO UPDATE SET modalidade='EXTRA',ativo=true;

-- Duas versões no mesmo dia: a anterior fica inativa, sem vigência inválida.
-- Quando aplicada em dia posterior, mantém a consulta da faixa histórica anterior.
UPDATE tabelas_preco SET vigencia_fim=GREATEST(vigencia_inicio,CURRENT_DATE-1),
  ativa=(vigencia_inicio<CURRENT_DATE) WHERE codigo='COMERCIAL_2026_09_ROLHA_V2';
COMMIT;
