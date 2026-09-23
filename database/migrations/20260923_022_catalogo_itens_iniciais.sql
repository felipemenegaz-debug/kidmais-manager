BEGIN;

-- Catálogo inicial editável. Esta migração não modifica fechamentos históricos.
WITH categorias(codigo,nome,ordem) AS (VALUES
 ('SALGADOS','Salgados',1),('DOCES','Doces',2),('MASSA_BOLO','Massa do bolo',3),
 ('RECHEIO_BOLO','Recheio do bolo',4),('BOMBONS','Bombons',5),
 ('EMPRATADOS','Empratados',6),('LEMBRANCINHAS','Lembrancinhas',7))
INSERT INTO buffet_categorias(codigo,nome,ordem_exibicao)
SELECT codigo,nome,ordem FROM categorias
ON CONFLICT (codigo) DO NOTHING;

WITH opcoes(categoria,codigo,nome,ordem) AS (VALUES
 ('SALGADOS','BOMBOM_MANDIOCA_CARNE_SECA','Bombom de mandioca com carne seca',1),
 ('SALGADOS','COXINHA_CATUPIRY','Coxinha com catupiry',2),
 ('SALGADOS','COXINHA','Coxinha sem catupiry',3),
 ('SALGADOS','DELICIA_QUEIJO','Delícia de queijo',4),
 ('SALGADOS','ENROLADINHO_ASSADO','Enroladinho de salsicha assado',5),
 ('SALGADOS','ENROLADINHO_FRITO','Enroladinho de salsicha frito',6),
 ('SALGADOS','KIBE_CATUPIRY','Kibe com catupiry',7),
 ('SALGADOS','KIBE','Kibe sem catupiry',8),
 ('SALGADOS','MINI_CHURROS','Mini churros',9),
 ('SALGADOS','NAPOLITANO','Napolitano',10),
 ('SALGADOS','QUEIJO_ALHO','Queijo com alho',11),
 ('SALGADOS','RICOTA_PEITO_PERU','Ricota com peito de peru',12),
 ('SALGADOS','RISOLES_CAMARAO','Risoles de camarão',13),
 ('SALGADOS','RISOLES_CARNE','Risoles de carne',14),
 ('SALGADOS','RISOLES_MILHO','Risoles de milho',15),
 ('SALGADOS','FOLHADO_ALHO_PORO','Folhado de alho poró',16),
 ('SALGADOS','FOLHADO_BANANA','Folhado de banana',17),
 ('SALGADOS','FOLHADO_FIO_OVOS','Folhado de fio de ovos',18),
 ('SALGADOS','FOLHADO_NOZES','Folhado de nozes',19),
 ('SALGADOS','EMPADA_CAMARAO','Empada de camarão',20),
 ('SALGADOS','EMPADA_FRANGO','Empada de frango',21),
 ('SALGADOS','EMPADA_PALMITO','Empada de palmito',22),
 ('SALGADOS','ESFIRRA_CARNE','Esfirra de carne',23),
 ('SALGADOS','QUICHE_ALHO_PORO','Quiche de alho poró',24),
 ('SALGADOS','QUICHE_BACON','Quiche de bacon',25),
 ('DOCES','BRIGADEIRO_PRETO','Brigadeiro preto',1),
 ('DOCES','BRIGADEIRO_PRETO_COPINHO','Brigadeiro preto de copinho',2),
 ('DOCES','BRIGADEIRO_BRANCO','Brigadeiro branco',3),
 ('DOCES','BRIGADEIRO_MARACUJA','Brigadeiro branco com maracujá',4),
 ('DOCES','BRIGADEIRO_NOZES','Brigadeiro branco com nozes',5),
 ('DOCES','BRIGADEIRO_PRETO_NOZES','Especial de brigadeiro preto com nozes',6),
 ('DOCES','PRESTIGIO','Prestígio',7),('DOCES','CASADINHO','Casadinho',8),
 ('DOCES','LEITE_NINHO','Doce de Leite Ninho',9),
 ('DOCES','BRIGADEIRO_AVELA','Brigadeiro de Avelã',10),
 ('DOCES','CAJUZINHO','Cajuzinho',11),('DOCES','DALMATAS','Dálmatas',12),
 ('DOCES','BEIJINHO','Beijinho',13),('DOCES','OLHO_SOGRA','Olho de sogra',14),
 ('DOCES','SETE_BELOS','7 Belos',15),('DOCES','DELICIAS_CAFE','Delícias de Café',16),
 ('MASSA_BOLO','BRANCA','Branca',1),('MASSA_BOLO','PRETA','Preta',2),
 ('MASSA_BOLO','MISTA','Mista',3),
 ('RECHEIO_BOLO','BRIGADEIRO_PRETO','Brigadeiro preto',1),
 ('RECHEIO_BOLO','BRIGADEIRO_BRANCO','Brigadeiro branco',2),
 ('RECHEIO_BOLO','LEITE_NINHO','Leite Ninho',3),
 ('RECHEIO_BOLO','NOZES','Nozes',4),('RECHEIO_BOLO','COCO','Coco',5),
 ('RECHEIO_BOLO','PISTACHE','Pistache',6),('RECHEIO_BOLO','MORANGO','Morango',7),
 ('BOMBONS','UVA','Uva',1),('BOMBONS','PRESTIGIO','Prestígio',2),
 ('BOMBONS','TRUFA','Trufa',3),('BOMBONS','NOZES','Nozes',4),
 ('EMPRATADOS','STROGONOFF','Strogonoff',1),
 ('EMPRATADOS','ESCONDIDINHO_CARNE_SECA','Escondidinho de carne seca',2),
 ('EMPRATADOS','ARROZ_CARRETEIRO','Arroz carreteiro',3),
 ('EMPRATADOS','PICADINHO_MOLHO_FERRUGEM','Picadinho de carne ao molho ferrugem',4),
 ('EMPRATADOS','FRANGO_MATRICIANA','Frango Matriciana',5),
 ('LEMBRANCINHAS','COPO','Copo',1),('LEMBRANCINHAS','BOLA','Bola',2))
INSERT INTO buffet_itens(categoria_id,codigo,nome,ordem_exibicao)
SELECT c.id,o.codigo,o.nome,o.ordem FROM opcoes o
JOIN buffet_categorias c ON c.codigo=o.categoria
ON CONFLICT (categoria_id,codigo) DO NOTHING;

-- Oito salgados, uma massa e um recheio; os demais limites permanecem
-- configuráveis sem presumir uma quantidade que ainda não foi definida.
WITH regra(pacote,categoria,limite) AS (VALUES
 ('POCKET','SALGADOS',8),('MINI_FESTA','SALGADOS',8),
 ('COMPACTA','SALGADOS',8),('ESSENCIAL','SALGADOS',8),
 ('COMPLETA','SALGADOS',8),('PREMIUM','SALGADOS',8),
 ('POCKET','DOCES',16),('MINI_FESTA','DOCES',16),
 ('ESSENCIAL','DOCES',16),('COMPLETA','DOCES',16),('PREMIUM','DOCES',16),
 ('POCKET','MASSA_BOLO',1),('MINI_FESTA','MASSA_BOLO',1),
 ('COMPACTA','MASSA_BOLO',1),('ESSENCIAL','MASSA_BOLO',1),
 ('COMPLETA','MASSA_BOLO',1),('PREMIUM','MASSA_BOLO',1),
 ('POCKET','RECHEIO_BOLO',1),('MINI_FESTA','RECHEIO_BOLO',1),
 ('COMPACTA','RECHEIO_BOLO',1),('ESSENCIAL','RECHEIO_BOLO',1),
 ('COMPLETA','RECHEIO_BOLO',1),('PREMIUM','RECHEIO_BOLO',1),
 ('MINI_FESTA','LEMBRANCINHAS',1),('COMPLETA','LEMBRANCINHAS',1),
 ('PREMIUM','LEMBRANCINHAS',1),('PREMIUM','BOMBONS',4),
 ('PREMIUM','EMPRATADOS',1))
INSERT INTO pacote_buffet_categorias(pacote_id,categoria_id,modo_itens,escolhas_min,escolhas_max)
SELECT p.id,c.id,'TODOS_ATIVOS',0,r.limite
FROM regra r JOIN pacotes p ON p.codigo=r.pacote JOIN buffet_categorias c ON c.codigo=r.categoria
ON CONFLICT (pacote_id,categoria_id) DO NOTHING;

COMMIT;
