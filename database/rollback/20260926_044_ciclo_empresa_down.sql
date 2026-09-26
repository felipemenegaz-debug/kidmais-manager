-- Devolve o gatilho à função permissiva da 031. Não apaga empresa e não edita a 031.
BEGIN;

DROP TRIGGER empresas_guard_trg ON empresas;

CREATE TRIGGER empresas_guard_trg
BEFORE INSERT OR UPDATE OR DELETE ON empresas
FOR EACH ROW
EXECUTE FUNCTION kidmais_031_guard_empresas();

DROP FUNCTION kidmais_044_guard_empresas();

COMMIT;
