-- Rollback possível: remove a guarda. Não apaga vínculo nem empresa.
-- Recusado como meio de consertar dado cruzado: este arquivo não dá UPDATE nem DELETE de catálogo.
-- Com os gatilhos presentes, a aplicação anterior segue para o par legado nulo e para a mesma empresa.
-- Sem os gatilhos, o buraco de tenant volta. Não usar este DOWN para "destravar" um vínculo cruzado.
BEGIN;

DROP TRIGGER IF EXISTS precos_pacote_empresa_trg ON precos_pacote;
DROP TRIGGER IF EXISTS pacote_adicionais_empresa_trg ON pacote_adicionais;
DROP TRIGGER IF EXISTS precos_adicional_empresa_trg ON precos_adicional;
DROP FUNCTION IF EXISTS kidmais_034_precos_pacote_empresa();
DROP FUNCTION IF EXISTS kidmais_034_pacote_adicionais_empresa();
DROP FUNCTION IF EXISTS kidmais_034_precos_adicional_empresa();
DROP FUNCTION IF EXISTS kidmais_034_recusar_empresa_distinta(uuid, uuid, text);

COMMIT;
