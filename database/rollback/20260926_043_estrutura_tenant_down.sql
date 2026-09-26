-- Remove a estrutura da 043. Não apaga empresas e não mexe nos sete pacotes.
-- A função da 031 permanece. Rodar isto depois de ciclos posteriores exige
-- remover antes os gatilhos que essas migrations penduraram nas mesmas tabelas.
BEGIN;

DROP TRIGGER IF EXISTS kidmais_043_me_truncate_trg ON membership_estabelecimentos;
DROP TRIGGER IF EXISTS kidmais_043_me_guard_trg ON membership_estabelecimentos;
DROP TRIGGER IF EXISTS kidmais_043_memberships_truncate_trg ON memberships;
DROP TRIGGER IF EXISTS kidmais_043_memberships_guard_trg ON memberships;
DROP TRIGGER IF EXISTS kidmais_043_estabelecimentos_truncate_trg ON estabelecimentos;
DROP TRIGGER IF EXISTS kidmais_043_estabelecimentos_guard_trg ON estabelecimentos;

DROP TABLE IF EXISTS membership_estabelecimentos;
DROP TABLE IF EXISTS memberships;
DROP TABLE IF EXISTS estabelecimentos;

DROP FUNCTION IF EXISTS kidmais_043_guard_membership_estabelecimentos();
DROP FUNCTION IF EXISTS kidmais_043_guard_memberships();
DROP FUNCTION IF EXISTS kidmais_043_guard_estabelecimentos();
DROP FUNCTION IF EXISTS kidmais_043_bloquear_truncate();

COMMIT;
