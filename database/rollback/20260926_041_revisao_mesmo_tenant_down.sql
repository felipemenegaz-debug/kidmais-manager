-- Remove a guarda da 041. A chave estrangeira da 032 permanece, sem empresa.
-- Não apaga pacote, não limpa revisao_anterior_id e não associa legado.
-- Sem este gatilho, SQL direto volta a poder cruzar empresas na revisão.
BEGIN;

DROP TRIGGER IF EXISTS pacotes_revisao_tenant_trg ON pacotes;
DROP FUNCTION IF EXISTS kidmais_041_revisao_mesmo_tenant();
DROP FUNCTION IF EXISTS kidmais_041_falhar_se_revisao_cruzada();

COMMIT;
