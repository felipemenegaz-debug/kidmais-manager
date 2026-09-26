-- Rollback possível: remove a guarda. Não apaga preço, não limpa publicada_em e não altera vigência.
-- Recusado como conserto: este arquivo não dá UPDATE nem DELETE de tabela ou preço.
-- Com os gatilhos presentes, a aplicação anterior segue para rascunho e para observação de preço.
-- Sem os gatilhos, publicação vazia e vigência sobreposta voltam a passar. Não usar este DOWN para publicar inválido.
BEGIN;

DROP TRIGGER IF EXISTS tabelas_preco_publicacao_trg ON tabelas_preco;
DROP TRIGGER IF EXISTS precos_pacote_tabela_publicada_trg ON precos_pacote;
DROP FUNCTION IF EXISTS kidmais_035_preservar_tabela_publicada();
DROP FUNCTION IF EXISTS kidmais_035_preservar_preco_publicado();

COMMIT;
