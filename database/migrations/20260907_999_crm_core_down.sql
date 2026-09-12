BEGIN;

-- Rollback integral do núcleo Clientes / CRM criado pelas migrations 001-004.
-- Usar somente em ambiente de desenvolvimento/teste.

DROP TABLE IF EXISTS possiveis_duplicidades_cliente;
DROP TABLE IF EXISTS mesclagens_clientes;

DROP TRIGGER IF EXISTS auditoria_bloquear_update_delete_trg ON auditoria;
DROP FUNCTION IF EXISTS kidmais_bloquear_mutacao_auditoria();
DROP TABLE IF EXISTS auditoria;
DROP TABLE IF EXISTS eventos_historico_cliente;

DROP TRIGGER IF EXISTS responsaveis_atualizado_em_trg ON responsaveis_adicionais;
DROP TABLE IF EXISTS responsaveis_adicionais;

DROP TRIGGER IF EXISTS aniversariantes_atualizado_em_trg ON aniversariantes;
DROP TABLE IF EXISTS aniversariantes;

DROP TRIGGER IF EXISTS clientes_atualizado_em_trg ON clientes;
DROP TRIGGER IF EXISTS clientes_validar_cliente_principal_trg ON clientes;
DROP FUNCTION IF EXISTS kidmais_validar_cliente_principal();
DROP TABLE IF EXISTS clientes;

DROP FUNCTION IF EXISTS kidmais_set_atualizado_em();

-- pgcrypto e pg_trgm não são removidas: podem ser utilizadas por outros módulos.

COMMIT;
