-- Devolve o gatilho à função da 043, que ainda não abre ATIVA.
-- Não apaga membership e não edita a 043.
BEGIN;

DROP TRIGGER kidmais_043_memberships_guard_trg ON memberships;

CREATE TRIGGER kidmais_043_memberships_guard_trg
BEFORE INSERT OR UPDATE OR DELETE ON memberships
FOR EACH ROW
EXECUTE FUNCTION kidmais_043_guard_memberships();

DROP FUNCTION kidmais_045_guard_memberships();

COMMIT;
