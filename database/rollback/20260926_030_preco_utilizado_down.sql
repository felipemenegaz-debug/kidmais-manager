BEGIN;

DROP TRIGGER IF EXISTS precos_pacote_calculo_utilizado_trg ON precos_pacote;
DROP TRIGGER IF EXISTS precos_adicional_calculo_utilizado_trg ON precos_adicional;
DROP FUNCTION IF EXISTS kidmais_030_preco_utilizado();

COMMIT;
