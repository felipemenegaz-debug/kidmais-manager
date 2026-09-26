-- Rollback possível: remove a imutabilidade da empresa do pai.
-- Não apaga vínculo, não limpa empresa_id e não reescreve o adicional legado sem empresa.
-- Sem estes gatilhos, UPDATE da empresa do pai volta a atravessar o tenant.
BEGIN;

DROP TRIGGER IF EXISTS pacotes_empresa_imutavel_trg ON pacotes;
DROP TRIGGER IF EXISTS tabelas_preco_empresa_imutavel_trg ON tabelas_preco;
DROP TRIGGER IF EXISTS adicionais_empresa_imutavel_trg ON adicionais;
DROP FUNCTION IF EXISTS kidmais_036_empresa_pai_imutavel();
DROP FUNCTION IF EXISTS kidmais_036_falhar_se_incompativel();

COMMIT;
