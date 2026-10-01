-- Remove a estrutura da 043 só quando as três tabelas estão vazias.
-- Não apaga empresas e não mexe nos sete pacotes.
-- A função da 031 permanece. Rodar isto depois de ciclos posteriores exige
-- remover antes os gatilhos que essas migrations penduraram nas mesmas tabelas.
--
-- Depois de uso real, não use este DOWN para destruir a Foundation.
-- Prefira o código anterior ou uma correção para frente. Se qualquer uma das
-- três tabelas já tiver linha, o rollback aborta e os dados permanecem.
--
-- Ordem fixa, em todo caminho que trava estas três tabelas juntas:
--   estabelecimentos → memberships → membership_estabelecimentos
-- A operação de tenant trava linha, não estas tabelas, nesta ordem:
--   usuarios_administrativos → empresas → memberships.
-- Este script não trava usuário nem empresa, então não inverte essa ordem.
--
-- ACCESS EXCLUSIVE conflita com INSERT, UPDATE e DELETE. É mais forte que o
-- SHARE ROW EXCLUSIVE da 038 porque este script termina em DROP TABLE.
-- Segurar o modo do DROP desde o início evita promover a trava por cima de um
-- FOR UPDATE de membership que a operação já tenha: a espera acontece na
-- aquisição, não entre a conferência e o DROP.
-- A trava permanece até COMMIT ou ROLLBACK.
BEGIN;

DO $$
DECLARE
  tabela text;
BEGIN
  FOREACH tabela IN ARRAY ARRAY[
    'estabelecimentos',
    'memberships',
    'membership_estabelecimentos'
  ]
  LOOP
    IF to_regclass('public.' || tabela) IS NULL THEN
      CONTINUE;
    END IF;
    EXECUTE format('LOCK TABLE public.%I IN ACCESS EXCLUSIVE MODE', tabela);
  END LOOP;
END $$;

DO $$
DECLARE
  n bigint;
  tabela text;
BEGIN
  FOREACH tabela IN ARRAY ARRAY[
    'estabelecimentos',
    'memberships',
    'membership_estabelecimentos'
  ]
  LOOP
    IF to_regclass('public.' || tabela) IS NULL THEN
      CONTINUE;
    END IF;
    EXECUTE format('SELECT count(*) FROM public.%I', tabela) INTO n;
    IF n > 0 THEN
      RAISE EXCEPTION '043 down: rollback recusado porque a Foundation já tem dado. Prefira o código anterior ou uma correção para frente.';
    END IF;
  END LOOP;
END $$;

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
