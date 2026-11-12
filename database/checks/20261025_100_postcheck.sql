-- Postcheck da 100 (somente leitura): a regra de conflito tem o corpo da 100.
DO $$
BEGIN
  IF (SELECT encode(sha256(convert_to(replace(prosrc, E'\r', ''), 'UTF8')), 'hex') FROM pg_proc WHERE oid = to_regprocedure('public.kidmais094_conflito_ocupacao(uuid,date,time without time zone,time without time zone,uuid,uuid,uuid,uuid)')) IS DISTINCT FROM '805cd427a7cc7a725fb3bdfb4fd050f04e618131104fcfc0678a0ddadd5b4bdb' THEN
    RAISE EXCEPTION '100 postcheck: corpo da regra de conflito diferente do da 100';
  END IF;
END $$;
