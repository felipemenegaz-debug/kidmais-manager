BEGIN;

-- Cria tabela comercial nova para a taxa de rolha. Preserva os IDs/preços da
-- tabela antiga referenciados por fechamentos e contratos históricos.
DO $$ BEGIN
  IF CURRENT_DATE <= DATE '2026-09-07' OR
     (SELECT count(*) FROM tabelas_preco WHERE ativa AND vigencia_inicio <= CURRENT_DATE
       AND (vigencia_fim IS NULL OR vigencia_fim >= CURRENT_DATE)) <> 1 OR
     NOT EXISTS (SELECT 1 FROM tabelas_preco WHERE codigo='COMERCIAL_2026_09'
       AND ativa AND vigencia_inicio < CURRENT_DATE
       AND (vigencia_fim IS NULL OR vigencia_fim >= CURRENT_DATE)) OR
     EXISTS (SELECT 1 FROM tabelas_preco WHERE codigo='COMERCIAL_2026_09_ROLHA_V2') THEN
    RAISE EXCEPTION 'Tabela base ou data inesperada: revisar vigência antes da taxa de rolha.';
  END IF;
END $$;

INSERT INTO tabelas_preco(codigo,nome,vigencia_inicio,ativa,observacoes)
VALUES ('COMERCIAL_2026_09_ROLHA_V2','Tabela comercial com taxa de rolha',CURRENT_DATE,true,
  'Clone da tabela anterior; taxa de rolha: 1–79 R$190, 80–150 R$290.');

INSERT INTO precos_pacote(tabela_preco_id,pacote_id,convidados_min,convidados_max,
  tipo_calculo,valor,categoria_horario,observacoes,ativo)
SELECT novo.id,p.pacote_id,p.convidados_min,p.convidados_max,p.tipo_calculo,
  p.valor,p.categoria_horario,p.observacoes,p.ativo
FROM precos_pacote p JOIN tabelas_preco antiga ON antiga.id=p.tabela_preco_id
CROSS JOIN tabelas_preco novo
WHERE antiga.codigo='COMERCIAL_2026_09' AND novo.codigo='COMERCIAL_2026_09_ROLHA_V2';

INSERT INTO precos_adicional(tabela_preco_id,adicional_id,convidados_min,convidados_max,
  valor,observacoes,ativo)
SELECT novo.id,p.adicional_id,p.convidados_min,p.convidados_max,p.valor,p.observacoes,p.ativo
FROM precos_adicional p JOIN tabelas_preco antiga ON antiga.id=p.tabela_preco_id
JOIN adicionais a ON a.id=p.adicional_id
CROSS JOIN tabelas_preco novo
WHERE antiga.codigo='COMERCIAL_2026_09' AND novo.codigo='COMERCIAL_2026_09_ROLHA_V2'
  AND a.codigo<>'BEBIDA_ALCOOLICA';

INSERT INTO precos_adicional(tabela_preco_id,adicional_id,convidados_min,convidados_max,valor,observacoes)
SELECT t.id,a.id,faixa.minimo,faixa.maximo,faixa.valor,'Taxa de rolha para evento.'
FROM tabelas_preco t CROSS JOIN adicionais a
CROSS JOIN (VALUES (1,79,190.00::numeric),(80,150,290.00::numeric)) AS faixa(minimo,maximo,valor)
WHERE t.codigo='COMERCIAL_2026_09_ROLHA_V2' AND a.codigo='BEBIDA_ALCOOLICA';

UPDATE tabelas_preco SET vigencia_fim=CURRENT_DATE-1
WHERE codigo='COMERCIAL_2026_09';

COMMIT;
