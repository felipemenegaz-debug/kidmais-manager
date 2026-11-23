-- Somente leitura. A 133 exige a 131 (forma atual da 094) e ainda não pode estar aplicada.
DO $$
BEGIN
  IF to_regprocedure('public.pre_reserva_exigir_configuracao()') IS NULL
     OR to_regprocedure('public.kidmais094_ocupacoes(date,date)') IS NULL
     OR to_regprocedure('public.kidmais062_mesmo_recurso(uuid,uuid,uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION '133 requer as estruturas 062, 094 e 131';
  END IF;
  IF (SELECT encode(sha256(convert_to(replace(pg_get_functiondef(p.oid), chr(13), ''), 'UTF8')), 'hex')
      FROM pg_proc p WHERE p.oid = to_regprocedure('public.kidmais094_ocupacoes(date,date)'))
     IS DISTINCT FROM '2fd9540c61c1d30bd64e53e912b90799e3cd6ab48d38f04ea82efe3f21385646' THEN
    RAISE EXCEPTION '133 requer a 094 exatamente como a 131 a deixou (definição divergente)';
  END IF;
  IF to_regprocedure('public.kidmais133_ocupacoes_escopo(date,date,uuid,uuid)') IS NOT NULL THEN
    RAISE EXCEPTION '133 já presente';
  END IF;
END $$;
