-- Dados SINTÉTICOS do ensaio local (nunca dados reais). :kidmais é trocado pelo id da empresa kidmais do banco descartável.
-- Somam-se ao que as migrations já semeiam (catálogo do buffet, 7 pacotes da kidmais com categorias, 33 adicionais) e aos
-- cinco bloqueios globais do reparo do lançamento (inseridos pelo ensaio).
INSERT INTO clientes (nome_completo, cpf, whatsapp, status, empresa_id) VALUES
  ('Cliente Sintetico Um', '00000000191', '61900000001', 'ATIVO', :kidmais),
  ('Cliente Sintetico Dois', '00000000272', '61900000002', 'ATIVO', :kidmais);
-- Legado sem empresa (054 permite NULL): continua único entre si depois da 076.
INSERT INTO clientes (nome_completo, cpf, status) VALUES ('Cliente Sintetico Legado', '00000000353', 'ATIVO');
-- Adicional do buffet com origem em item do catálogo (070), da própria kidmais: a 078 não copia nada.
INSERT INTO adicionais (codigo, nome, categoria, unidade_cobranca, ordem_exibicao, categoria_id, empresa_id, origem_buffet_item_id)
SELECT 'SINTETICO_ITEM', 'Adicional sintetico do buffet', a.categoria, 'UNIDADE', 99, a.categoria_id, :kidmais,
       (SELECT id FROM buffet_itens WHERE categoria_id IS NOT NULL ORDER BY codigo LIMIT 1)
  FROM adicionais a WHERE a.codigo = 'SORVETE';
