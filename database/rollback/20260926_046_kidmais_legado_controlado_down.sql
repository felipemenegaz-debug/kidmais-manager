-- Não desfaz a Kidmais, não limpa empresa_id e não apaga membership.
-- Depois do uso, o reparo é o código anterior ou uma correção para frente.
BEGIN;

DO $$ BEGIN
  IF to_regclass('public.empresas') IS NOT NULL
     AND EXISTS (SELECT 1 FROM empresas WHERE codigo = 'kidmais') THEN
    RAISE EXCEPTION '046: a atribuição da Kidmais não é desfeita por este script.';
  END IF;
END $$;

COMMIT;
